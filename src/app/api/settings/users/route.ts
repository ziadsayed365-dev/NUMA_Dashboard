import { NextRequest, NextResponse } from "next/server";
import { denyUnlessEdit, getViewer } from "@/lib/access";
import { normalizePermissions } from "@/lib/permissions";
import { createUser } from "@/lib/settings/users";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = await denyUnlessEdit("settings:users");
  if (denied) return denied;

  const body = await request.json();
  const { username, password, role: newUserRole, permissions } = body;

  if (
    typeof username !== "string" ||
    !username.trim() ||
    typeof password !== "string" ||
    !password ||
    (newUserRole !== "owner" && newUserRole !== "staff")
  ) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  // The Users tab can be granted to a non-owner, so it must not be a way to
  // mint full access - only an owner creates owners.
  if (newUserRole === "owner" && !(await getViewer()).isOwner) {
    return NextResponse.json({ ok: false, error: "Only an owner can create owner accounts" }, { status: 403 });
  }

  try {
    await createUser({ username, password, role: newUserRole, permissions: normalizePermissions(permissions) });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
