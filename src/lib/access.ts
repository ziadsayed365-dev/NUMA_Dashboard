import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { SESSION_COOKIE_NAME, verifySessionToken, type Session } from "@/lib/auth";
import {
  canEdit,
  canView,
  findPage,
  firstAllowedPath,
  normalizePermissions,
  NO_ACCESS,
  type Viewer,
} from "@/lib/permissions";

export type SessionViewer = Viewer & { session: Session | null; canSync: boolean };

const SIGNED_OUT: SessionViewer = { session: null, canSync: false, ...NO_ACCESS };

// Running a sync isn't a tab, so it isn't in the permission tree - it's the one
// owner-level action handed out by name. Owners always have it; these staff
// accounts have it too, so they can refresh the dashboard themselves without
// waiting on an owner. Compared case-insensitively against `users.username`.
const SYNC_USERNAMES = new Set(["amagdy"]);

function grantsSync(username: string | null | undefined): boolean {
  return typeof username === "string" && SYNC_USERNAMES.has(username.trim().toLowerCase());
}

// The authoritative access check. Permissions are read from the database on
// every request rather than baked into the cookie, so an owner changing
// someone's tabs takes effect on that person's next page load instead of after
// they sign in again. src/proxy.ts only does the cheap cookie check - this is
// what actually decides what a page or API route will do.
export const getViewer = cache(async (): Promise<SessionViewer> => {
  const store = await cookies();
  const session = verifySessionToken(store.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!session) return SIGNED_OUT;

  // The .env.local fallback owner has no users row to look up.
  if (session.role === "owner" && session.userId === null) {
    return { session, isOwner: true, canSync: true, permissions: {} };
  }
  if (session.userId === null) return SIGNED_OUT;

  const { data, error } = await supabase
    .from("users")
    .select("role, username, permissions")
    .eq("id", session.userId)
    .maybeSingle();

  // The permissions column is missing until migration 0069 is applied in the
  // Supabase SQL editor. Rather than lock everyone out of a live dashboard,
  // fall back to the role alone: owners keep working, and everyone else gets
  // nothing until the migration lands.
  if (error) {
    const { data: fallback } = await supabase
      .from("users")
      .select("role, username")
      .eq("id", session.userId)
      .maybeSingle();
    if (!fallback) return SIGNED_OUT;
    const isOwner = fallback.role === "owner";
    return { session, isOwner, canSync: isOwner || grantsSync(fallback.username), permissions: {} };
  }

  if (!data) return SIGNED_OUT; // deleted account
  if (data.role === "owner") return { session, isOwner: true, canSync: true, permissions: {} };

  return {
    session,
    isOwner: false,
    canSync: grantsSync(data.username),
    permissions: normalizePermissions(data.permissions),
  };
});

export async function viewerCanView(key: string): Promise<boolean> {
  return canView(await getViewer(), key);
}

export async function viewerCanEdit(key: string): Promise<boolean> {
  return canEdit(await getViewer(), key);
}

// Page guard. Returns the viewer when they're allowed in; otherwise sends them
// to the first tab they DO have (so a user without the Income Statement doesn't
// bounce off "/" forever) and returns null when there's nowhere to send them,
// which the page renders as <NoAccess />.
export async function requirePageView(pageKey: string): Promise<SessionViewer | null> {
  const viewer = await getViewer();
  if (canView(viewer, pageKey)) return viewer;

  // No session at all (expired cookie, or the account was deleted while they
  // were signed in) - the proxy's optimistic check can't catch that.
  if (!viewer.session) redirect("/login");

  const target = firstAllowedPath(viewer);
  if (target && target !== findPage(pageKey)?.href) redirect(target);
  return null;
}

/** Owner-only pages. Redirects rather than leaking that the page exists. */
export async function requireOwnerPage(): Promise<SessionViewer> {
  const viewer = await getViewer();
  if (!viewer.isOwner) redirect(firstAllowedPath(viewer) ?? "/login");
  return viewer;
}

const forbidden = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });

// API guards - `const denied = await denyUnless...; if (denied) return denied;`
export async function denyUnlessEdit(key: string): Promise<NextResponse | null> {
  return (await viewerCanEdit(key)) ? null : forbidden();
}

export async function denyUnlessView(key: string): Promise<NextResponse | null> {
  return (await viewerCanView(key)) ? null : forbidden();
}

export async function denyUnlessOwner(): Promise<NextResponse | null> {
  return (await getViewer()).isOwner ? null : forbidden();
}

/** Owners plus the named accounts in SYNC_USERNAMES - see the Sync button. */
export async function denyUnlessSync(): Promise<NextResponse | null> {
  return (await getViewer()).canSync ? null : forbidden();
}

export async function denyUnlessSignedIn(): Promise<NextResponse | null> {
  return (await getViewer()).session ? null : forbidden();
}
