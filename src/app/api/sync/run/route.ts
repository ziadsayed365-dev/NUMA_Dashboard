import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { REPORT_CACHE_TAG } from "@/lib/reports/cache";
import { denyUnlessSync } from "@/lib/access";
import { syncShopifyOrders } from "@/lib/sync/shopify-orders";
import { syncShopifyProducts } from "@/lib/sync/shopify-products";
import { syncMetaSpend } from "@/lib/sync/meta-spend";
import { runCalibration } from "@/lib/engine/calibration";
import { computeMargins } from "@/lib/engine/margin";
import { finalizeMonthlyRates, finalizeSkuMonthlyRates } from "@/lib/engine/monthly-rate";
import { markRecordDataSynced } from "@/lib/record-data/expenses";

// The margins recompute over the full order history can exceed 60s; Vercel
// allows up to 300s, so give the sync steps that headroom.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Steps run in this order - shopify before shopify-products (so newly-mapped
// line items still get this same pass's margin recompute), monthly-rate
// before sku-monthly-rate (which falls back to it), and margins last (after
// every other input is settled). Split into one request per step, rather
// than one request doing all of them, because the combined runtime (~80s
// for the full pipeline) exceeds a single serverless function's budget -
// each step on its own comfortably fits.
const STEPS = ["shopify", "shopify-products", "meta", "calibrate", "monthly-rate", "sku-monthly-rate", "margins"] as const;
type Step = (typeof STEPS)[number];

async function runStep(step: Step) {
  switch (step) {
    case "shopify":
      return syncShopifyOrders();
    case "shopify-products":
      return syncShopifyProducts();
    case "meta":
      return syncMetaSpend();
    case "calibrate":
      return runCalibration();
    case "monthly-rate":
      return finalizeMonthlyRates();
    case "sku-monthly-rate":
      return finalizeSkuMonthlyRates();
    case "margins": {
      const result = await computeMargins();
      await markRecordDataSynced(); // unlocks the Report tab's pending entries up to this point
      return result;
    }
  }
}

export async function POST(request: NextRequest) {
  // AI NUMA's nightly run presses Sync with CRON_SECRET instead of a login.
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;
  if (!isCron) {
    const denied = await denyUnlessSync();
    if (denied) return denied;
  }

  const step = request.nextUrl.searchParams.get("step") as Step | null;
  if (!step || !STEPS.includes(step)) {
    return NextResponse.json({ ok: false, error: `Invalid or missing step (expected one of ${STEPS.join(", ")})` }, { status: 400 });
  }

  const result = await runStep(step);
  const error = "error" in result && result.error ? result.error : undefined;
  // The reports are cached for a short window (see src/lib/reports/cache.ts), so
  // drop them here - otherwise a finished Sync would appear to have done nothing
  // until the cache expired on its own. `{ expire: 0 }` rather than "max":
  // "max" is stale-while-revalidate and would still serve the pre-sync numbers
  // on the very next load.
  if (result.ok) revalidateTag(REPORT_CACHE_TAG, { expire: 0 });
  return NextResponse.json({ step, ...result, ...(error ? { error } : {}) }, { status: result.ok ? 200 : 500 });
}
