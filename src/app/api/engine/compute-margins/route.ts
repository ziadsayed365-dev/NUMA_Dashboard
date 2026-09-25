import { NextRequest, NextResponse } from "next/server";
import { computeMargins } from "@/lib/engine/margin";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// The deliberate full rebuild of every order's margin (Sync only recomputes the
// recent window - see computeMargins). Run it after a change that must reach old
// orders, e.g. a cost correction backdated months.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 403 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = await computeMargins({ fullHistory: true });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
