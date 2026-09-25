import "server-only";
import { NextResponse, type NextRequest } from "next/server";

// Every /api/agent/* route is for AI NUMA only (scripts/ai-numa), which carries
// CRON_SECRET instead of a login. `const denied = denyUnlessAgent(request); if (denied) return denied;`
export function denyUnlessAgent(request: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 403 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}
