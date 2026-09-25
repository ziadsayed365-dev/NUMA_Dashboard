import "server-only";
import crypto from "crypto";
import { supabase } from "@/lib/supabase";

export const SESSION_COOKIE_NAME = "izar_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// There used to be a third role, `operations`, with its own fixed page list.
// Per-user permissions replaced all of that: a user is either an owner (full
// access, always) or staff (exactly the tabs ticked for them in Settings →
// Users). Migration 0069 converts anyone who held `operations` to staff with
// Expense & Income + Purchasing ticked, which is what the role granted.
export type Role = "owner" | "staff";

// Who the cookie says you are. The user id is what per-tab permissions hang
// off (see src/lib/access.ts); it's null only for the .env.local fallback
// owner, who has no row in the users table.
export type Session = { role: Role; userId: number | null };

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Database-backed accounts (managed from /settings) are checked first;
// falls back to the original .env.local owner credentials so the owner
// can never be fully locked out if something goes wrong with the users
// table.
export async function resolveLogin(username: string, password: string): Promise<Session | null> {
  const { data: user, error } = await supabase
    .from("users")
    .select("id, role, password_hash")
    .eq("username", username)
    .maybeSingle();

  if (!error && user && verifyPassword(password, user.password_hash)) {
    // Any leftover `operations` row logs in as staff; its permissions map is
    // what decides the tabs now (migration 0069 backfills it).
    return { role: user.role === "owner" ? "owner" : "staff", userId: user.id as number };
  }

  const ownerUser = process.env.OWNER_USERNAME;
  const ownerPass = process.env.OWNER_PASSWORD;
  if (ownerUser && ownerPass && username === ownerUser && password === ownerPass) {
    return { role: "owner", userId: null };
  }
  return null;
}

// Token = "<role>.<user id>.<expiry epoch ms>.<hmac signature>" - never stores
// the raw password, just proves whoever issued it knew SESSION_SECRET. The id
// is 0 for the .env.local fallback owner. Tokens issued before per-user
// permissions had no id segment and no longer verify, so everyone signs in
// once more after this ships.
export function createSessionToken(session: Session, secret: string): string {
  const expiry = String(Date.now() + SESSION_DURATION_MS);
  const payload = `${session.role}.${session.userId ?? 0}.${expiry}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined, secret: string | undefined): Session | null {
  if (!token || !secret) return null;
  const [role, userId, expiry, signature] = token.split(".");
  if (!role || !userId || !expiry || !signature) return null;
  if (role !== "owner" && role !== "staff") return null;
  if (!/^\d+$/.test(userId)) return null;
  if (Date.now() > Number(expiry)) return null;

  const expected = sign(`${role}.${userId}.${expiry}`, secret);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;

  return { role: role as Role, userId: Number(userId) === 0 ? null : Number(userId) };
}
