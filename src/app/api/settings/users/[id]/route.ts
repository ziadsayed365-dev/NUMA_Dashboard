import { NextRequest, NextResponse } from "next/server";
import { denyUnlessEdit, getViewer } from "@/lib/access";
import { normalizePermissions } from "@/lib/permissions";
import { deleteUser, getUserRole, updateUser } from "@/lib/settings/users";

export const dynamic = "force-dynamic";

const forbidden = (error: string) => NextResponse.json({ ok: false, error }, { status: 403 });

// The Users tab is grantable to a non-owner, so ownership itself stays out of
// reach from it: a non-owner can manage staff accounts, but can't promote
// anyone (themselves included) to owner, and can't touch an owner's account.
async function denyOwnerEscalation(targetId: number, newUserRole: unknown): Promise<NextResponse | null> {
  if ((await getViewer()).isOwner) return null;
  if (newUserRole === "owner") return forbidden("Only an owner can grant owner access");
  if ((await getUserRole(targetId)) === "owner") return forbidden("Only an owner can change an owner account");
  return null;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await denyUnlessEdit("settings:users");
  if (denied) return denied;

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isFinite(userId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await request.json();
  const { username, password, role: newUserRole, permissions } = body;

  if (newUserRole !== undefined && newUserRole !== "owner" && newUserRole !== "staff") {
    return NextResponse.json({ ok: false, error: "Invalid role" }, { status: 400 });
  }

  const escalation = await denyOwnerEscalation(userId, newUserRole);
  if (escalation) return escalation;

  try {
    await updateUser(userId, {
      username: typeof username === "string" ? username : undefined,
      password: typeof password === "string" && password ? password : undefined,
      role: newUserRole,
      permissions: permissions === undefined ? undefined : normalizePermissions(permissions),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await denyUnlessEdit("settings:users");
  if (denied) return denied;

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isFinite(userId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const escalation = await denyOwnerEscalation(userId, undefined);
  if (escalation) return escalation;

  try {
    await deleteUser(userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
