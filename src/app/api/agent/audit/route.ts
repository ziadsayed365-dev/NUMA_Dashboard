import { NextRequest, NextResponse } from "next/server";
import { denyUnlessAgent } from "@/lib/agent/auth";
import { runNightlyAudit } from "@/lib/reports/nightly-audit";
import { egyptToday, addDays } from "@/lib/dates";

// Several full reports on a cold cache (the day, both modes, and the 28-day
// baseline) - give it the same headroom as the sync steps.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// AI NUMA's nightly check, run right after its sync. ?day=YYYY-MM-DD picks the
// day to report on; default is yesterday in Egypt time, the day the nightly PDF
// covers.
export async function GET(request: NextRequest) {
  const denied = denyUnlessAgent(request);
  if (denied) return denied;

  const dayParam = request.nextUrl.searchParams.get("day");
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : addDays(egyptToday(), -1);

  try {
    return NextResponse.json(await runNightlyAudit(day));
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "audit failed" }, { status: 500 });
  }
}
