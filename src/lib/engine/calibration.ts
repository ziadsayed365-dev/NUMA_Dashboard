import "server-only";
import { cache } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";

const RESOLVED_OUTCOMES = ["delivered", "failed_rto"];
const MATURITY_DAYS = 15;

function egyptToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Per-PRODUCT delivery-rate calibration. Each Shopify product (single or
// bundle) gets its own rate = delivered / (delivered + returned), blended with
// the store-wide rate when its own sample is too small to trust. Bundles and
// singles are each measured as themselves (no overlap) since attribution is by
// the product on the order line.
export async function runCalibration(): Promise<{ ok: boolean; productsCalibrated: number; storeWideRate: number; error?: string }> {
  try {
    const { data: settings, error: settingsErr } = await supabase.from("settings").select("*").eq("id", 1).single();
    if (settingsErr || !settings) throw new Error(`Failed to load settings: ${settingsErr?.message}`);

    const { calibration_min_sample: minSample, calibration_min_ignore: minIgnore, default_success_rate_estimate: defaultRate, attempt2_factor, attempt3plus_factor } = settings;

    const maturityCutoffMs = Date.now() - MATURITY_DAYS * 24 * 60 * 60 * 1000;

    const lineItems = await fetchAllRows<{
      product_id: number | null;
      orders: { outcome: string | null; order_created_at: string } | null;
    }>(supabase, "order_line_items", "id, product_id, orders(outcome, order_created_at)");

    const byProduct = new Map<number, { resolved: number; delivered: number }>();
    let storeResolved = 0;
    let storeDelivered = 0;

    for (const li of lineItems) {
      const order = li.orders;
      if (!order || !li.product_id) continue;
      if (!RESOLVED_OUTCOMES.includes(order.outcome ?? "")) continue;
      if (new Date(order.order_created_at).getTime() > maturityCutoffMs) continue;

      const pid = li.product_id;
      if (!byProduct.has(pid)) byProduct.set(pid, { resolved: 0, delivered: 0 });
      const entry = byProduct.get(pid)!;
      entry.resolved++;
      storeResolved++;
      if (order.outcome === "delivered") {
        entry.delivered++;
        storeDelivered++;
      }
    }

    const storeWideRate = storeResolved > 0 ? storeDelivered / storeResolved : defaultRate;

    const { data: allProducts, error: productsErr } = await supabase.from("products").select("id");
    if (productsErr) throw new Error(`Failed to load products: ${productsErr.message}`);

    const today = egyptToday();
    const rows = (allProducts ?? []).map((p) => {
      const stats = byProduct.get(p.id) ?? { resolved: 0, delivered: 0 };
      const n = stats.resolved;
      const rawRate = n > 0 ? stats.delivered / n : null;

      let blendedRate: number;
      if (n >= minSample) {
        blendedRate = rawRate!;
      } else if (n < minIgnore) {
        blendedRate = storeWideRate;
      } else {
        blendedRate = (n / minSample) * rawRate! + ((minSample - n) / minSample) * storeWideRate;
      }

      return {
        product_id: p.id,
        as_of_date: today,
        raw_rate: rawRate,
        resolved_sample_size: n,
        store_wide_rate: storeWideRate,
        blended_rate: blendedRate,
        attempt_adjusted_rates: {
          "1": blendedRate,
          "2": blendedRate * attempt2_factor,
          "3+": blendedRate * attempt3plus_factor,
        },
        created_at: new Date().toISOString(),
      };
    });

    const { error: upsertErr } = await supabase
      .from("product_success_rates")
      .upsert(rows, { onConflict: "product_id,as_of_date" });
    if (upsertErr) throw new Error(`Failed to upsert calibration results: ${upsertErr.message}`);

    return { ok: true, productsCalibrated: rows.length, storeWideRate };
  } catch (err) {
    return { ok: false, productsCalibrated: 0, storeWideRate: 0, error: err instanceof Error ? err.message : "unknown error" };
  }
}

export type CalibratedRates = {
  // Each product's own calibrated delivery rate (blended toward the store-wide
  // rate when its sample is thin) - the same rates margin.ts uses per order.
  ratesByProduct: Map<number, number>;
  // Sample-weighted store-wide delivery rate across all products, or null if
  // nothing has been calibrated yet.
  storeWide: number | null;
};

// Reads the most recent calibration snapshot (product_success_rates) into a
// per-product rate map plus a store-wide blend. This is the real delivery rate
// used to project the still-open month, instead of the flat settings default.
export const getCalibratedRates = cache(async (): Promise<CalibratedRates> => {
  const { data: latestDateRow, error: latestErr } = await supabase
    .from("product_success_rates")
    .select("as_of_date")
    .order("as_of_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) throw new Error(`Failed to find latest calibration date: ${latestErr.message}`);
  if (!latestDateRow) return { ratesByProduct: new Map(), storeWide: null };

  const rows = await fetchAllRows<{
    product_id: number;
    blended_rate: number | null;
    raw_rate: number | null;
    resolved_sample_size: number | null;
  }>(
    supabase,
    "product_success_rates",
    "product_id, blended_rate, raw_rate, resolved_sample_size",
    (query) => query.eq("as_of_date", latestDateRow.as_of_date),
    ["product_id"] // no id column - PK is (product_id, as_of_date), and as_of_date is fixed here
  );

  const ratesByProduct = new Map<number, number>();
  let weightedDelivered = 0;
  let totalResolved = 0;
  for (const r of rows) {
    if (r.blended_rate != null) ratesByProduct.set(r.product_id, Number(r.blended_rate));
    // Store-wide = actual delivered/resolved across products (raw_rate reflects
    // the real observed rate before small-sample blending).
    const n = r.resolved_sample_size ?? 0;
    if (n > 0 && r.raw_rate != null) {
      weightedDelivered += Number(r.raw_rate) * n;
      totalResolved += n;
    }
  }
  const storeWide = totalResolved > 0 ? weightedDelivered / totalResolved : null;
  return { ratesByProduct, storeWide };
});
