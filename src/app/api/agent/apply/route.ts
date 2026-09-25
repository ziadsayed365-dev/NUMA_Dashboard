import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessAgent } from "@/lib/agent/auth";
import { applyAgentActions, type AgentAction } from "@/lib/agent/actions";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_ACTIONS = 25;

function parseAction(raw: unknown): AgentAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (a.type === "set_tiktok_spend" && typeof a.date === "string" && typeof a.amount === "number") {
    return { type: "set_tiktok_spend", date: a.date, amount: a.amount };
  }
  if (a.type === "allocate_ad" && typeof a.adId === "string" && a.adId) {
    const names = a.productNames ?? [];
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) return null;
    return { type: "allocate_ad", adId: a.adId, productNames: names as string[], general: a.general === true };
  }
  return null;
}

// The fixes AI NUMA applies after the owner answers a nightly message. Every
// action is one the owner could make on the dashboard, and none overwrites an
// existing entry or allocation (see src/lib/agent/actions.ts).
export async function POST(request: NextRequest) {
  const denied = denyUnlessAgent(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  const raw = Array.isArray(body?.actions) ? body.actions : null;
  if (!raw || raw.length === 0) {
    return NextResponse.json({ ok: false, error: "actions must be a non-empty array" }, { status: 400 });
  }
  if (raw.length > MAX_ACTIONS) {
    return NextResponse.json({ ok: false, error: `at most ${MAX_ACTIONS} actions per request` }, { status: 400 });
  }

  const actions: AgentAction[] = [];
  for (const item of raw) {
    const parsed = parseAction(item);
    if (!parsed) {
      return NextResponse.json({ ok: false, error: `Unrecognised action: ${JSON.stringify(item)}` }, { status: 400 });
    }
    actions.push(parsed);
  }

  const results = await applyAgentActions(actions);
  // The reports are cached (src/lib/reports/cache.ts); drop them so the
  // re-check and PDF that follow see these changes.
  if (results.some((r) => r.ok)) revalidateTag(REPORT_CACHE_TAG, { expire: 0 });
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}
