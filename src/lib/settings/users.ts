import "server-only";
import { supabase } from "@/lib/supabase";
import { hashPassword, type Role } from "@/lib/auth";
import { normalizePermissions, type PermissionMap } from "@/lib/permissions";

export type AppUser = {
  id: number;
  username: string;
  role: Role;
  /** Always {} for owners - they have full access and ignore the column. */
  permissions: PermissionMap;
};

export async function getUsers(): Promise<AppUser[]> {
  const { data, error } = await supabase
    .from("users")
    .select("id, username, role, permissions")
    .order("username", { ascending: true });

  // Same pre-migration fallback as getViewer(): show the users list even if the
  // permissions column isn't there yet (see supabase/migrations/0069).
  if (error) {
    const { data: fallback, error: fallbackErr } = await supabase
      .from("users")
      .select("id, username, role")
      .order("username", { ascending: true });
    if (fallbackErr) throw new Error(`Failed to load users: ${fallbackErr.message}`);
    return (fallback ?? []).map((u) => ({ id: u.id, username: u.username, role: u.role as Role, permissions: {} }));
  }

  return (data ?? []).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role as Role,
    permissions: u.role === "owner" ? {} : normalizePermissions(u.permissions),
  }));
}

/** Used by the API to decide whether the caller is allowed near this account. */
export async function getUserRole(id: number): Promise<Role | null> {
  const { data, error } = await supabase.from("users").select("role").eq("id", id).maybeSingle();
  if (error) throw new Error(`Failed to look up user: ${error.message}`);
  return (data?.role as Role) ?? null;
}

export type CreateUserInput = { username: string; password: string; role: Role; permissions?: PermissionMap };

export async function createUser(input: CreateUserInput): Promise<void> {
  if (!input.username.trim()) throw new Error("Username is required");
  if (!input.password) throw new Error("Password is required");

  const permissions = input.role === "owner" ? {} : normalizePermissions(input.permissions ?? {});
  if (input.role !== "owner" && Object.keys(permissions).length === 0) {
    throw new Error("Pick at least one tab this user can open");
  }

  const { error } = await supabase.from("users").insert({
    username: input.username.trim(),
    password_hash: hashPassword(input.password),
    role: input.role,
    permissions,
  });
  if (error) throw new Error(`Failed to create user: ${error.message}`);
}

export type UpdateUserInput = { username?: string; password?: string; role?: Role; permissions?: PermissionMap };

export async function updateUser(id: number, input: UpdateUserInput): Promise<void> {
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.username !== undefined) {
    if (!input.username.trim()) throw new Error("Username is required");
    values.username = input.username.trim();
  }
  if (input.password) values.password_hash = hashPassword(input.password);
  if (input.role !== undefined) values.role = input.role;

  // Promoting someone to owner clears the map (owners aren't restricted);
  // otherwise save whatever the matrix sent, normalized.
  if (input.role === "owner") {
    values.permissions = {};
  } else if (input.permissions !== undefined) {
    const permissions = normalizePermissions(input.permissions);
    if (Object.keys(permissions).length === 0) throw new Error("Pick at least one tab this user can open");
    values.permissions = permissions;
  }

  const { error } = await supabase.from("users").update(values).eq("id", id);
  if (error) throw new Error(`Failed to update user: ${error.message}`);
}

export async function deleteUser(id: number): Promise<void> {
  const { count, error: countErr } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role", "owner");
  if (countErr) throw new Error(`Failed to check owner count: ${countErr.message}`);

  const { data: target, error: targetErr } = await supabase.from("users").select("role").eq("id", id).maybeSingle();
  if (targetErr) throw new Error(`Failed to look up user: ${targetErr.message}`);

  if (target?.role === "owner" && (count ?? 0) <= 1) {
    throw new Error("Can't delete the last owner account");
  }

  const { error } = await supabase.from("users").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete user: ${error.message}`);
}
