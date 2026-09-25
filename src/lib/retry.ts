import "server-only";

// Supabase sits behind Cloudflare and intermittently answers with a 520/504 - or
// with an error carrying no message at all - that succeeds on an immediate
// retry. Without a retry a single blip throws out of whatever pass is running,
// silently leaving the dashboard hours stale (or failing a whole Sync on one
// unlucky query).
const MAX_ATTEMPTS = 4;

export function isTransient(message: string): boolean {
  // A blank message is the signature of a blip that never reached PostgREST:
  // there is no PostgREST error body to read a reason out of. A real query
  // error always names itself, so this only ever catches the transport failing.
  if (message.trim() === "") return true;
  return (
    /\b(408|429|50[0-4]|52[0-4])\b/.test(message) ||
    /timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|unknown error|try again/i.test(message)
  );
}

// Renders a PostgREST error as something diagnosable. supabase-js hands back an
// empty `message` when the request never reached PostgREST (a Cloudflare blip in
// front of the pooler), and `${err.message}` alone then produced the useless
// "Failed to count order_line_items: " that a failing Sync used to report.
export function describeSupabaseError(err: { message?: string; code?: string; details?: string; hint?: string } | null): string {
  if (!err) return "unknown error";
  const parts = [err.message, err.code && `code ${err.code}`, err.details, err.hint].filter(
    (v): v is string => typeof v === "string" && v.trim() !== ""
  );
  return parts.length > 0 ? parts.join(" | ") : "empty error (request did not reach PostgREST)";
}

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_ATTEMPTS || !isTransient(message)) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}
