import "server-only";
import { cache } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";

// The heavy reads the reporting pages depend on, each scoped to the window the
// caller is reporting on and memoized so a page only pays for a dataset once.
//
// Both halves matter. Scoping: every one of these used to pull the whole
// history (43k orders / 113k line items, 1000 rows per round-trip) and filter
// it down in JS, so asking for a single day cost the same as asking for
// everything. Every filter below is the exact same test the caller then applies
// in memory - both modes date an order by `egypt_day` (see actualReportDay), so
// there is one column to push down and no rows are lost by pushing it.
//
// Memoization: `cache()` collapses repeat calls within one render scope, and
// `shared()` below collapses identical scans that overlap in time even across
// scopes. Neither ever serves a row across requests, so a fresh sync still shows
// up on the next navigation. Callers must treat the returned arrays as read-only
// (filter/map, never mutate in place) since they're shared between callers.

// Identical scans running at the same moment share one fetch. React's `cache()`
// can't do this on its own: each `unstable_cache` callback runs in its own scope,
// so the Analysis by Product page - four cached reports resolved in one
// Promise.all - fired the same full-table scan three times over on a cold cache,
// saturating the connection pooler until Postgres cancelled the statements
// ("canceling statement due to statement timeout"). The entry is dropped as soon
// as the fetch settles, so this only ever merges concurrent callers.
const inFlight = new Map<string, Promise<unknown>>();

function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started = run().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

export type MatureOrderRow = {
  egypt_day: string;
  outcome: string | null;
  cancelled_at: string | null;
  courier: string;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
  bosta_tracking_number: string | null; // Actual's delivery test - see actualDelivery
  shipping_fee_charged: number | null;
  order_line_items: {
    quantity: number;
    revenue: number | null;
    cost_of_goods: number | null;
    allocated_courier_fee: number | null;
    allocated_courier_fee_blended: number | null;
    allocated_open_package_fee: number | null;
    allocated_cod_cash_fee: number | null;
    packing_cost: number | null;
    refund_adjustment: number | null;
    damage_adjustment: number | null;
  }[];
};

export const getMatureOrders = cache((from: string, to: string) =>
  shared(`mature-orders:${from}:${to}`, () =>
    fetchAllRows<MatureOrderRow>(
      supabase,
      "orders",
      "id, egypt_day, outcome, cancelled_at, courier, bosta_picked_up_day, movers_record_date, bosta_tracking_number, shipping_fee_charged, order_line_items(quantity, revenue, cost_of_goods, allocated_courier_fee, allocated_courier_fee_blended, allocated_open_package_fee, allocated_cod_cash_fee, packing_cost, refund_adjustment, damage_adjustment)",
      (query) => query.gte("egypt_day", from).lte("egypt_day", to)
    )
  )
);

export type OpenMonthOrderRow = {
  egypt_day: string;
  cancelled_at: string | null;
  outcome: string | null;
  courier: string;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
  bosta_tracking_number: string | null; // the Delivery Rate numerator's test - see reachedCustomer
  outcome_governorate: string | null;
  governorate_shopify: string | null;
  cod_amount_collected: number | null;
  total_price: number | null;
  shipping_fee_charged: number | null;
  order_line_items: {
    product_id: number | null;
    quantity: number;
    unit_price: number;
  }[];
};

export const getOpenMonthOrders = cache((from: string, to: string) =>
  shared(`open-month-orders:${from}:${to}`, () =>
    fetchAllRows<OpenMonthOrderRow>(
      supabase,
      "orders",
      "id, egypt_day, cancelled_at, outcome, courier, bosta_picked_up_day, movers_record_date, bosta_tracking_number, outcome_governorate, governorate_shopify, cod_amount_collected, total_price, shipping_fee_charged, order_line_items(product_id, quantity, unit_price)",
      (query) => query.gte("egypt_day", from).lte("egypt_day", to)
    )
  )
);

export type PerProductLineItemRow = {
  product_id: number | null;
  quantity: number;
  unit_price: number | null;
  revenue: number | null;
  cost_of_goods: number | null;
  orders: {
    egypt_day: string;
    outcome: string | null;
    cancelled_at: string | null;
    courier: string;
    bosta_picked_up_day: string | null;
    movers_record_date: string | null;
    bosta_tracking_number: string | null;
  } | null;
};

// `orders!inner` so the window filters on the parent order's day. The inner join
// also drops line items with no order row, which every caller already skipped
// (no order -> no day to report it on).
export const getPerProductLineItems = cache((from: string, to: string) =>
  shared(`per-product-line-items:${from}:${to}`, () =>
    fetchAllRows<PerProductLineItemRow>(
      supabase,
      "order_line_items",
      "id, product_id, quantity, unit_price, revenue, cost_of_goods, orders!inner(egypt_day, outcome, cancelled_at, courier, bosta_picked_up_day, movers_record_date, bosta_tracking_number)",
      (query) => query.gte("orders.egypt_day", from).lte("orders.egypt_day", to)
    )
  )
);

// The store-wide P&L marketing total: every ad_spend row's date + spend in the
// window, regardless of which product (if any) the campaign is allocated to.
// Per-product ad attribution lives in per-product.ts, which queries product_id
// directly.
export type AdSpendRow = { date: string; spend: number; source: string };

export const getAdSpendRows = cache((from: string, to: string) =>
  shared(`ad-spend:${from}:${to}`, () =>
    fetchAllRows<AdSpendRow>(supabase, "ad_spend", "id, date, spend, source", (query) => query.gte("date", from).lte("date", to))
  )
);
