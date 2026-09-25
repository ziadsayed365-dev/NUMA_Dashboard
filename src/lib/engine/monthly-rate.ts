import "server-only";
import { cache } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday, addDays, firstOfMonth, firstOfNextMonth } from "@/lib/dates";
import { getCalibratedRates } from "./calibration";
import { ACTUAL_RECORDING_START, actualDelivery, actualShipDay, reachedCustomer } from "@/lib/shipping/shared";

const RESOLVED_OUTCOMES = ["delivered", "failed_rto"];
const MATURITY_DAYS = 15; // same buffer calibration.ts uses before trusting an order's outcome

// Time-only maturity: the month has ended and the buffer has passed. Still what
// the rate-engine finalizers below walk by, since they write a historical record
// per month and must terminate. Reporting uses the stricter closure test below.
export function isMonthMature(month: string): boolean {
  return egyptToday() >= addDays(firstOfNextMonth(month), MATURITY_DAYS);
}

// How long after a month ends its last stragglers are still worth waiting for.
// Past this the month closes on the outcomes it has: in practice a Bosta order
// with no outcome by then is one that will never get one (the sync strands them
// - it stores the events but never writes the outcome), and letting a single
// stuck order discard a whole month's real figures costs far more than it saves.
const CLOSURE_BACKSTOP_DAYS = 10;

type ClosureRow = {
  egypt_day: string | null;
  outcome: string | null;
  cancelled_at: string | null;
  courier: string | null;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
  bosta_tracking_number: string | null;
};

// Every order's outcome-shaped columns, request-memoized. Deliberately its own
// narrow scan rather than reusing the reports' order fetch: this runs from the
// engine and needs no line items.
const getClosureRows = cache(() =>
  fetchAllRows<ClosureRow>(
    supabase,
    "orders",
    "id, egypt_day, outcome, cancelled_at, courier, bosta_picked_up_day, movers_record_date, bosta_tracking_number"
  )
);

// A month is CLOSED - safe to report real per-order figures for, and to project
// the next month from - once it has ended AND either every order a courier holds
// in it is decided, or CLOSURE_BACKSTOP_DAYS have passed since it ended.
//
// Time alone isn't enough while the wait is still short: a month whose orders are
// genuinely still in flight would otherwise be reported as final while its
// outcomes were still moving. This replaces the flat isMonthMature timer for
// reporting - a month now earns its closure instead of ageing into it.
export const getClosedMonths = cache(async (): Promise<Set<string>> => {
  const rows = await getClosureRows();

  // "Decided" is exactly actualDelivery's non-"unconfirmed" answer: delivered,
  // or returned. A Khazenly parcel still on the road (no DELIVERED / NOT_DELIVERED
  // on its Shopify fulfillment yet) is what holds a month open.
  const undecidedByMonth = new Map<string, number>();
  const seenMonths = new Set<string>();
  for (const o of rows) {
    if (!o.egypt_day) continue;
    const month = firstOfMonth(o.egypt_day);
    seenMonths.add(month);
    if (o.cancelled_at || !o.courier) continue; // never shipped: nothing to wait on
    if (actualDelivery(o) === "unconfirmed") undecidedByMonth.set(month, (undecidedByMonth.get(month) ?? 0) + 1);
  }

  const today = egyptToday();
  const closed = new Set<string>();
  for (const month of seenMonths) {
    const monthEnd = firstOfNextMonth(month);
    if (today < monthEnd) continue; // still running
    const allDecided = (undecidedByMonth.get(month) ?? 0) === 0;
    const waitedLongEnough = today >= addDays(monthEnd, CLOSURE_BACKSTOP_DAYS);
    if (allDecided || waitedLongEnough) closed.add(month);
  }
  return closed;
});

// Delivered ÷ the orders that mode actually reports on, for one month:
//   performance - every order Shopify took, cancellations included, so orders
//                 nobody ever shipped count against it (the whole-business rate).
//   actual      - only the orders Actual reports on (a courier holds them - see
//                 actualShipDay), since that is the set Actual multiplies. Using
//                 the business rate here would discount the never-shipped orders
//                 twice: once by excluding them, again by a rate that already
//                 assumed they fail.
export async function getMonthDeliveryRate(month: string, mode: "performance" | "actual"): Promise<number | null> {
  const monthEnd = firstOfNextMonth(month);

  // A month wholly before recording began has no honest Actual rate to give. Back
  // then actualShipDay admitted an order only if Bosta had already called it
  // delivered, so numerator and denominator are the same set and the month reads
  // a meaningless 100% - an artifact of the fallback, not a real result. Return
  // null so getProjectionRate walks past it to a recording-era month (or to
  // calibration) instead of quoting it. Performance is unaffected: its
  // denominator is every order, which is real in that window too.
  if (mode === "actual" && monthEnd <= ACTUAL_RECORDING_START) return null;
  const rows = (await getClosureRows()).filter(
    (o): o is ClosureRow & { egypt_day: string } => o.egypt_day !== null && o.egypt_day >= month && o.egypt_day < monthEnd
  );

  const denominator = mode === "actual" ? rows.filter((o) => actualShipDay(o) !== null) : rows;
  if (denominator.length === 0) return null;
  return denominator.filter(reachedCustomer).length / denominator.length;
}

// Computes and stores the real store-wide delivery rate for every calendar
// month that has just matured but doesn't have a row yet. Always inserts
// exactly one row per mature month (falling back to the settings default
// if a month happens to have zero resolved orders), so the loop is
// guaranteed to terminate and never re-checks an already-finalized month.
export async function finalizeMonthlyRates(): Promise<{ ok: boolean; monthsFinalized: number; error?: string }> {
  try {
    const { data: settingsRow, error: settingsErr } = await supabase
      .from("settings")
      .select("default_success_rate_estimate")
      .eq("id", 1)
      .single();
    if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
    const fallbackRate = Number(settingsRow.default_success_rate_estimate);

    const { data: latestFinalized, error: latestErr } = await supabase
      .from("monthly_delivery_rates")
      .select("month")
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) throw new Error(`Failed to load monthly_delivery_rates: ${latestErr.message}`);

    let month: string;
    if (latestFinalized) {
      month = firstOfNextMonth(latestFinalized.month);
    } else {
      const { data: earliestOrder, error: earliestErr } = await supabase
        .from("orders")
        .select("egypt_day")
        .order("egypt_day", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (earliestErr) throw new Error(`Failed to load earliest order: ${earliestErr.message}`);
      if (!earliestOrder) return { ok: true, monthsFinalized: 0 };
      month = firstOfMonth(earliestOrder.egypt_day);
    }

    let monthsFinalized = 0;
    while (isMonthMature(month)) {
      const monthEnd = firstOfNextMonth(month);

      const { count: resolvedCount, error: resolvedErr } = await supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .gte("egypt_day", month)
        .lt("egypt_day", monthEnd)
        .in("outcome", RESOLVED_OUTCOMES);
      if (resolvedErr) throw new Error(`Failed to count resolved orders for ${month}: ${resolvedErr.message}`);

      const { count: deliveredCount, error: deliveredErr } = await supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .gte("egypt_day", month)
        .lt("egypt_day", monthEnd)
        .eq("outcome", "delivered");
      if (deliveredErr) throw new Error(`Failed to count delivered orders for ${month}: ${deliveredErr.message}`);

      const resolved = resolvedCount ?? 0;
      const delivered = deliveredCount ?? 0;
      const rate = resolved > 0 ? delivered / resolved : fallbackRate;

      const { error: upsertErr } = await supabase.from("monthly_delivery_rates").upsert(
        { month, resolved_count: resolved, delivered_count: delivered, rate },
        { onConflict: "month" }
      );
      if (upsertErr) throw new Error(`Failed to upsert monthly_delivery_rates for ${month}: ${upsertErr.message}`);

      monthsFinalized++;
      month = monthEnd;
    }

    return { ok: true, monthsFinalized };
  } catch (err) {
    return { ok: false, monthsFinalized: 0, error: err instanceof Error ? err.message : "unknown error" };
  }
}

export type ProjectionRate = { rate: number; sourceMonth: string | null };

// The rate that projects every still-open month: the most recently CLOSED
// month's real delivery rate, computed live for the requested mode. Falls back
// to the calibrated store-wide rate (real observed, from product_success_rates),
// then to the settings placeholder if nothing has been calibrated yet.
//
// Computed rather than read from monthly_delivery_rates on purpose. That table
// stores one definition (delivered/resolved) frozen at the moment a month
// matured, and it never back-fills, so the projection drifted from the month it
// claimed to come from - and the rate driving the whole open month appeared
// nowhere in the UI. Reading the orders each time keeps the rate honest, and lets
// the two modes use the denominator that matches the orders each one multiplies.
// The table is still written by the finalizers above as a historical record.
export async function getProjectionRate(mode: "performance" | "actual" = "performance"): Promise<ProjectionRate> {
  const sorted = [...(await getClosedMonths())].sort();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const rate = await getMonthDeliveryRate(sorted[i], mode);
    if (rate !== null) return { rate, sourceMonth: sorted[i] };
  }

  // No closed month yet (a new store, or every month still has an undecided
  // order and none has reached the backstop).
  const { storeWide } = await getCalibratedRates();
  if (storeWide != null) return { rate: storeWide, sourceMonth: null };

  const { data: settingsRow, error: settingsErr } = await supabase
    .from("settings")
    .select("default_success_rate_estimate")
    .eq("id", 1)
    .single();
  if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
  return { rate: Number(settingsRow.default_success_rate_estimate), sourceMonth: null };
}

// Per-SKU (individual color/variant) analog of finalizeMonthlyRates - same
// month-by-month maturity walk, but counted per product instead of
// store-wide. A SKU with zero resolved orders in a given month has no
// rate of its own (mathematically undefined), so it falls back to that
// exact month's store-wide rate rather than the store-wide rate of the
// month it shipped in being blended/guessed.
export async function finalizeSkuMonthlyRates(): Promise<{ ok: boolean; monthsFinalized: number; error?: string }> {
  try {
    const { data: settingsRow, error: settingsErr } = await supabase
      .from("settings")
      .select("default_success_rate_estimate")
      .eq("id", 1)
      .single();
    if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
    const globalFallbackRate = Number(settingsRow.default_success_rate_estimate);

    const { data: latestFinalized, error: latestErr } = await supabase
      .from("sku_monthly_delivery_rates")
      .select("month")
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) throw new Error(`Failed to load sku_monthly_delivery_rates: ${latestErr.message}`);

    let month: string;
    if (latestFinalized) {
      month = firstOfNextMonth(latestFinalized.month);
    } else {
      const { data: earliestOrder, error: earliestErr } = await supabase
        .from("orders")
        .select("egypt_day")
        .order("egypt_day", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (earliestErr) throw new Error(`Failed to load earliest order: ${earliestErr.message}`);
      if (!earliestOrder) return { ok: true, monthsFinalized: 0 };
      month = firstOfMonth(earliestOrder.egypt_day);
    }

    const { data: products, error: productsErr } = await supabase.from("products").select("id");
    if (productsErr) throw new Error(`Failed to load products: ${productsErr.message}`);

    let monthsFinalized = 0;
    while (isMonthMature(month)) {
      const monthEnd = firstOfNextMonth(month);

      const { data: storeRateRow, error: storeRateErr } = await supabase
        .from("monthly_delivery_rates")
        .select("rate")
        .eq("month", month)
        .maybeSingle();
      if (storeRateErr) throw new Error(`Failed to load monthly_delivery_rates for ${month}: ${storeRateErr.message}`);
      const fallbackRate = storeRateRow ? Number(storeRateRow.rate) : globalFallbackRate;

      const lineItems = await fetchAllRows<{ product_id: number | null; orders: { outcome: string | null } | null }>(
        supabase,
        "order_line_items",
        "id, product_id, orders!inner(egypt_day, outcome)",
        (query) => query.gte("orders.egypt_day", month).lt("orders.egypt_day", monthEnd)
      );

      const byProduct = new Map<number, { resolved: number; delivered: number }>();
      for (const li of lineItems) {
        if (!li.product_id) continue;
        const outcome = li.orders?.outcome ?? null;
        if (!RESOLVED_OUTCOMES.includes(outcome ?? "")) continue;
        if (!byProduct.has(li.product_id)) byProduct.set(li.product_id, { resolved: 0, delivered: 0 });
        const entry = byProduct.get(li.product_id)!;
        entry.resolved++;
        if (outcome === "delivered") entry.delivered++;
      }

      const rows = (products ?? []).map((p) => {
        const stats = byProduct.get(p.id) ?? { resolved: 0, delivered: 0 };
        const rate = stats.resolved > 0 ? stats.delivered / stats.resolved : fallbackRate;
        return {
          product_id: p.id,
          month,
          resolved_count: stats.resolved,
          delivered_count: stats.delivered,
          rate,
          created_at: new Date().toISOString(),
        };
      });

      if (rows.length > 0) {
        const { error: upsertErr } = await supabase
          .from("sku_monthly_delivery_rates")
          .upsert(rows, { onConflict: "product_id,month" });
        if (upsertErr) throw new Error(`Failed to upsert sku_monthly_delivery_rates for ${month}: ${upsertErr.message}`);
      }

      monthsFinalized++;
      month = monthEnd;
    }

    return { ok: true, monthsFinalized };
  } catch (err) {
    return { ok: false, monthsFinalized: 0, error: err instanceof Error ? err.message : "unknown error" };
  }
}

export type SkuProjectionRate = { rate: number; sourceMonth: string | null };

// The rate used to project each SKU's own open-month revenue/COGS. Priority:
// (1) that SKU's most recently finalized month (real, month-specific); else
// (2) its calibrated all-recent delivery rate (product_success_rates); else
// (3) the store-wide projection rate. This is what replaced the old flat
// settings default - a product with a real rate now projects with it.
export async function getSkuProjectionRates(): Promise<{
  ratesByProduct: Map<number, SkuProjectionRate>;
  fallback: SkuProjectionRate;
}> {
  const fallback = await getProjectionRate();
  const { ratesByProduct: calibrated } = await getCalibratedRates();

  const rows = await fetchAllRows<{ product_id: number; month: string; rate: number }>(
    supabase,
    "sku_monthly_delivery_rates",
    "product_id, month, rate",
    undefined,
    ["product_id", "month"] // no id column - composite primary key is (product_id, month)
  );

  // Latest finalized month per product (empty until months mature + finalize).
  const monthlyLatest = new Map<number, { rate: number; month: string }>();
  for (const row of rows) {
    const existing = monthlyLatest.get(row.product_id);
    if (!existing || row.month > existing.month) {
      monthlyLatest.set(row.product_id, { rate: Number(row.rate), month: row.month });
    }
  }

  const ratesByProduct = new Map<number, SkuProjectionRate>();
  // Base layer: each product's calibrated rate (no specific source month).
  for (const [productId, rate] of calibrated) ratesByProduct.set(productId, { rate, sourceMonth: null });
  // Override with a finalized month-specific rate where one exists.
  for (const [productId, m] of monthlyLatest) ratesByProduct.set(productId, { rate: m.rate, sourceMonth: m.month });

  return { ratesByProduct, fallback };
}
