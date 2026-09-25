import "server-only";
import { unstable_cache } from "next/cache";
import { REPORT_CACHE_SECONDS, REPORT_CACHE_TAG } from "./cache";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { firstOfMonth, addDays } from "@/lib/dates";
import { getClosedMonths, getSkuProjectionRates, type SkuProjectionRate } from "@/lib/engine/monthly-rate";
import { getPerProductLineItems } from "./pnl-data";
import { getBuiltCostByProduct } from "@/lib/products/final-products";
import { actualReportDay, actualDelivery } from "@/lib/shipping/shared";

const RESOLVED_OUTCOMES = ["delivered", "failed_rto", "exchange", "pickup_return"];

// One product's roll-up over the reporting window. Laurel has no model groups,
// so the report is a flat list of products (singles and bundles) rather than
// the old two-level model -> color grouping.
export type ProductReportRow = {
  productId: number;
  name: string;
  sku: string | null;
  isBundle: boolean;
  ordersPlaced: number;
  ordersResolved: number;
  itemsSold: number;
  revenue: number;
  cogs: number;
  // The 100%-delivery basis: every order in the window at full value, ignoring
  // returns entirely - the same money the Meta dashboard reports back. Feeds the
  // Meta Dashboard half of Key Ratios; `revenue`/`cogs` above stay the delivered
  // basis and feed the Actual half.
  grossRevenue: number;
  grossCogs: number;
  // This product's own delivery rate (its last finalized month, else its
  // calibrated rate, else the store-wide fallback). Always populated, unlike
  // openMonthRate below, which is only set when the window touches an open month.
  deliveryRate: number;
  grossProfit: number;
  // Product-level ad spend: the total spend of every ad allocated to this product
  // over the window, plus its share of shared spend - General and ads pinned to
  // several products, split equally (see splitSharedAdSpend for the Subscription
  // exception). Unallocated ads are excluded.
  adSpend: number;
  contributionProfit: number;
  costMissing: boolean; // no Product List BOM entered -> COGS understated, profit overstated
  openMonthRate: number | null; // this product's own delivery rate used to project the open month, if any
  openMonthRateSourceMonth: string | null;
};

export type PerProductMode = "performance" | "actual";

// Typeahead option for the per-product Rollforward picker. `sku` lets the
// picker be searched by SKU as well as name (for when the name isn't memorable).
export type ProductOption = { id: number; label: string; sku: string | null };

// One day in the per-product Rollforward (the same metrics as the per-product
// table, but per calendar day for a single product).
export type ProductDailyRow = {
  date: string;
  // Total items sold (sum of order line quantities) before the delivery-rate
  // haircut - i.e. units if every order delivered.
  volume: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  adSpend: number;
  contributionProfit: number;
};

export type OpenMonthInfo = { month: string };

// The Rollforward payload for one product: its daily rows plus the single
// delivery rate that projects the open month (and drives the delivered-volume
// reference line), so the UI shows the product's real rate rather than a flat 50%.
export type ProductDailyRollforward = {
  rows: ProductDailyRow[];
  deliveryRate: number | null; // the product's own projection rate, or null if it has no orders/rate
  rateSourceMonth: string | null; // the mature month that rate came from, if any
};

export type PerProductResult = {
  products: ProductReportRow[];
  openMonthInfo: OpenMonthInfo | null;
};

// Both modes date by the Shopify order date (egypt_day - never touched); they
// differ in which orders count. Actual defers to actualReportDay, the same shared
// rule the Income Statement uses (src/lib/reports/daily-pnl.ts), so the two
// reports can't drift apart.
function effectiveDay(
  order: {
    egypt_day: string;
    outcome: string | null;
    courier: string | null;
    bosta_picked_up_day: string | null;
    movers_record_date: string | null;
  } | null,
  mode: PerProductMode
): string | null {
  if (!order) return null;
  if (mode === "performance") return order.egypt_day;
  return actualReportDay(order);
}

// Finds the earliest still-open month touching [from, to] - same rule the Income
// Statement uses (src/lib/reports/daily-pnl.ts), so a SKU's revenue/COGS switch
// over to the delivery-rate projection on exactly the same boundary the P&L does.
// A month is only final once it has ended AND every order a courier holds in it
// is decided, or the backstop has passed (see getClosedMonths) - if the two
// pages used different rules they would disagree about which month switched over.
// Performance only: Actual never projects (see getPerProductReport).
function findOpenMonthBoundary(from: string, to: string, closed: Set<string>): string | null {
  const floor = firstOfMonth(from);
  let month = firstOfMonth(to);
  let boundary: string | null = null;
  while (!closed.has(month)) {
    boundary = month;
    if (month <= floor) break;
    month = firstOfMonth(addDays(month, -1));
  }
  return boundary;
}

// Ad spend that isn't pinned to ONE product, over [from, to]:
//   general - TikTok "General" (source='tiktok', product_id null) and any ad marked
//             General in Ad Allocation (an ad_assignments row with neither
//             product_id nor product_ids). Bucketed by day.
//   multi   - ads pinned to several products (ad_assignments.product_ids), each
//             spend row kept with its products so it can be split among them.
// A still-unallocated ad (no assignment row at all) is neither and is excluded;
// it only counts in the store-wide P&L marketing total.
type SharedAdSpend = {
  generalByDay: Map<string, number>;
  multi: { date: string; spend: number; productIds: number[] }[];
};

async function getSharedAdSpend(from: string, to: string): Promise<SharedAdSpend> {
  const { data: assigned, error: aErr } = await supabase
    .from("ad_assignments")
    .select("ad_id, product_ids")
    .is("product_id", null);
  if (aErr) throw new Error(`Failed to load shared ad assignments: ${aErr.message}`);
  const productIdsByAd = new Map<string, number[]>();
  for (const a of (assigned ?? []) as { ad_id: string; product_ids: number[] | null }[]) {
    productIdsByAd.set(a.ad_id, (a.product_ids ?? []).map(Number));
  }

  // Keyed by ad_spend.id so a row counts once even if it matches both queries.
  const rowsById = new Map<number, { spend: number; date: string; ad_id: string | null }>();
  const tiktokRows = await fetchAllRows<{ id: number; spend: number; date: string }>(
    supabase,
    "ad_spend",
    "id, spend, date",
    (query) => query.eq("source", "tiktok").is("product_id", null).gte("date", from).lte("date", to)
  );
  for (const r of tiktokRows) rowsById.set(r.id, { spend: Number(r.spend), date: r.date, ad_id: null });

  if (productIdsByAd.size > 0) {
    const assignedRows = await fetchAllRows<{ id: number; spend: number; date: string; ad_id: string }>(
      supabase,
      "ad_spend",
      "id, spend, date, ad_id",
      (query) => query.in("ad_id", [...productIdsByAd.keys()]).is("product_id", null).gte("date", from).lte("date", to)
    );
    for (const r of assignedRows) rowsById.set(r.id, { spend: Number(r.spend), date: r.date, ad_id: r.ad_id });
  }

  const generalByDay = new Map<string, number>();
  const multi: SharedAdSpend["multi"] = [];
  for (const r of rowsById.values()) {
    const ids = r.ad_id ? productIdsByAd.get(r.ad_id) ?? [] : [];
    if (ids.length > 0) multi.push({ date: r.date, spend: r.spend, productIds: ids });
    else generalByDay.set(r.date, (generalByDay.get(r.date) ?? 0) + r.spend);
  }
  return { generalByDay, multi };
}

// Which products sold on each day of [from, to] - a product "sold" on a day when
// it has at least one order line the report counts for that day (the mode's own
// inclusion test, cancellations out). Only the Subscription's days matter to the
// split below.
function soldProductsByDay(
  lineItems: Awaited<ReturnType<typeof getPerProductLineItems>>,
  mode: PerProductMode,
  from: string,
  to: string
): Map<string, Set<number>> {
  const byDay = new Map<string, Set<number>>();
  for (const li of lineItems) {
    if (!li.product_id) continue;
    const order = li.orders;
    if (order?.cancelled_at) continue;
    const day = effectiveDay(order, mode);
    if (day === null || day < from || day > to) continue;
    const set = byDay.get(day) ?? new Set<number>();
    set.add(li.product_id);
    byDay.set(day, set);
  }
  return byDay;
}

// Who shared spend can land on: General goes to every ACTIVE Shopify product
// (archived / draft ones sell nothing), and the Subscription products get the
// special rule in splitSharedAdSpend. Subscription = name says "subscription",
// the same test the Subscription tab uses.
type SplitTargets = { active: number[]; subscription: Set<number> };

async function getSplitTargets(): Promise<SplitTargets> {
  const { data, error } = await supabase.from("products").select("id, name, status");
  if (error) throw new Error(`Failed to load products for the ad split: ${error.message}`);
  const rows = (data ?? []) as { id: number; name: string | null; status: string | null }[];
  return {
    active: rows.filter((r) => !r.status || r.status.toUpperCase() === "ACTIVE").map((r) => r.id),
    subscription: new Set(rows.filter((r) => /subscription/i.test(r.name ?? "")).map((r) => r.id)),
  };
}

// Each product's share of the shared spend, per day. The owner's rule:
//   - Spend is split EQUALLY across its products every day, whether or not
//     they sold: General across every active product, a multi-product ad across
//     the products ticked for it.
//   - Except the Subscription: it only takes a share on a day a subscription
//     was sold. On any other day it is left out and the spend is split across
//     the rest. (An ad ticked to the Subscription alone keeps its spend there
//     every day - leaving it out would leave nobody to carry it.)
// Both the product table and the Rollforward use this, so they always agree.
function splitSharedAdSpend(
  shared: SharedAdSpend,
  soldByDay: Map<string, Set<number>>,
  targets: SplitTargets
): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  const add = (productId: number, day: string, amount: number) => {
    const byDay = out.get(productId) ?? new Map<string, number>();
    byDay.set(day, (byDay.get(day) ?? 0) + amount);
    out.set(productId, byDay);
  };
  const eligible = (ids: number[], day: string): number[] => {
    const sold = soldByDay.get(day);
    const kept = ids.filter((id) => !targets.subscription.has(id) || (sold?.has(id) ?? false));
    return kept.length > 0 ? kept : ids;
  };
  const split = (ids: number[], day: string, spend: number) => {
    const to = eligible(ids, day);
    for (const id of to) add(id, day, spend / to.length);
  };
  if (targets.active.length > 0) {
    for (const [day, spend] of shared.generalByDay) split(targets.active, day, spend);
  }
  for (const row of shared.multi) split(row.productIds, row.date, row.spend);
  return out;
}

// Cached for the same reason as the Income Statement report - see ./cache.ts.
export const getPerProductReport = unstable_cache(computePerProductReport, ["per-product"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

async function computePerProductReport(
  from: string,
  to: string,
  mode: PerProductMode = "performance"
): Promise<PerProductResult> {
  const { data: products, error: productsErr } = await supabase.from("products").select("id, name, sku, is_bundle");
  if (productsErr) throw new Error(`Failed to load products: ${productsErr.message}`);
  const productById = new Map((products ?? []).map((p) => [p.id, p]));

  // Actual reports exactly what was recorded shipped, so it never projects - not
  // even the still-open month (matching the Income Statement's Actual tab). Only
  // Performance, which counts orders before their outcome is known, needs the rate.
  const boundary = mode === "actual" ? null : findOpenMonthBoundary(from, to, await getClosedMonths());

  // Always loaded, not just when the window touches an open month: every row
  // reports its own delivery rate so Key Ratios can turn orders placed into
  // orders expected to deliver. Only the open-month PROJECTION below is still
  // gated on `boundary`.
  const skuRates: { ratesByProduct: Map<number, SkuProjectionRate>; fallback: SkuProjectionRate } =
    await getSkuProjectionRates();

  // Open-month COGS is projected from the Product List BOM cost per product,
  // the same source margin.ts uses once the month closes (Laurel has no model
  // groups, so the old model_group unit_cost path projected COGS as 0).
  const builtCostByProduct = await getBuiltCostByProduct();

  // Ad spend allocated to each product over the window, bucketed by the ad's
  // own spend date (a campaign is allocated to exactly one product via the
  // Analysis-by-Product popup). Unallocated campaigns have product_id null and
  // are excluded here - they still count in the store-wide P&L marketing total.
  const adRows = await fetchAllRows<{ product_id: number | null; spend: number }>(
    supabase,
    "ad_spend",
    "id, product_id, spend",
    (query) => query.gte("date", from).lte("date", to).not("product_id", "is", null)
  );
  const adByProduct = new Map<number, number>();
  for (const r of adRows) {
    if (r.product_id == null) continue;
    adByProduct.set(r.product_id, (adByProduct.get(r.product_id) ?? 0) + Number(r.spend));
  }

  // Spend not pinned to one product (General, or several products) - split per
  // day below, so it's reflected in per-product marketing/contribution without
  // appearing as its own line.
  const sharedAdSpend = await getSharedAdSpend(from, to);

  // Windowed on the order's Shopify day, which is what effectiveDay resolves to
  // in either mode (see actualReportDay). "actual" then means the order was
  // recorded as handed to a courier in the Shipping Orders tab - or, before
  // recording began, one Bosta delivered - which the loop below tests per line,
  // in both the mature and the still-open month.
  const lineItems = await getPerProductLineItems(from, to);

  type Stats = {
    ordersPlaced: number;
    ordersResolved: number;
    itemsSold: number;
    revenue: number;
    cogs: number;
    grossRevenue: number;
    grossCogs: number;
    openMonthRate: number | null;
    openMonthRateSourceMonth: string | null;
  };
  const statsByProduct = new Map<number, Stats>();
  function getStats(productId: number): Stats {
    if (!statsByProduct.has(productId)) {
      statsByProduct.set(productId, {
        ordersPlaced: 0,
        ordersResolved: 0,
        itemsSold: 0,
        revenue: 0,
        cogs: 0,
        grossRevenue: 0,
        grossCogs: 0,
        openMonthRate: null,
        openMonthRateSourceMonth: null,
      });
    }
    return statsByProduct.get(productId)!;
  }

  for (const li of lineItems) {
    if (!li.product_id) continue;
    const order = li.orders;
    // The query windowed these by day; this is the mode's own inclusion test -
    // Actual reports only the orders a courier was actually handed.
    if (effectiveDay(order, mode) === null) continue;
    if (order?.cancelled_at) continue; // never placed in any practical sense - deterministic zero, not rate-dependent

    const s = getStats(li.product_id);
    s.ordersPlaced++;
    const isResolved = RESOLVED_OUTCOMES.includes(order?.outcome ?? "");
    if (isResolved) s.ordersResolved++;

    const isOpenMonth = boundary !== null && (effectiveDay(order, mode) ?? "") >= boundary;
    // The 100%-delivery basis, booked BEFORE the Actual delivery test below - it
    // counts every order in the window at full value, which is exactly what makes
    // it comparable to what the ad platform reports. Same two sources the
    // delivered basis draws on: the stored per-order figures once a month has
    // closed, price x quantity and the BOM cost while it is still open.
    if (isOpenMonth) {
      s.grossRevenue += li.quantity * (li.unit_price ?? 0);
      s.grossCogs += (builtCostByProduct.get(li.product_id) ?? 0) * li.quantity;
    } else {
      s.grossRevenue += li.revenue ?? 0;
      s.grossCogs += li.cost_of_goods ?? 0;
    }

    // In Actual an order that hasn't been confirmed delivered was still shipped
    // (it counts in ordersPlaced/Resolved above), but it earns nothing yet - no
    // items, revenue or COGS - and one that came back never will. Same shared
    // rule the Income Statement books revenue on. Performance is unchanged and
    // counts every order at full revenue.
    if (mode === "actual" && order && actualDelivery(order) !== "delivered") continue;
    s.itemsSold += li.quantity ?? 0;

    if (isOpenMonth) {
      // Same projection style the Income Statement uses for the still-open
      // month, but with each SKU's own delivery rate instead of one
      // blanket store-wide rate - applied uniformly across every order
      // for that SKU regardless of its real, already-known outcome.
      const { rate, sourceMonth } = skuRates.ratesByProduct.get(li.product_id) ?? skuRates.fallback;
      s.openMonthRate = rate;
      s.openMonthRateSourceMonth = sourceMonth;

      const unitCost = builtCostByProduct.get(li.product_id) ?? 0;
      s.revenue += rate * (li.quantity * (li.unit_price ?? 0));
      s.cogs += rate * (unitCost * li.quantity);
    } else {
      s.revenue += li.revenue ?? 0;
      s.cogs += li.cost_of_goods ?? 0;
    }
  }

  // One row per product that actually had orders in the window. A product's
  // COGS is missing (profit overstated) when it has no Product List BOM.
  const result: ProductReportRow[] = [];
  for (const [productId, s] of statsByProduct) {
    const product = productById.get(productId);
    const grossProfit = s.revenue - s.cogs;
    const adSpend = adByProduct.get(productId) ?? 0;
    result.push({
      productId,
      name: product?.name ?? `#${productId}`,
      sku: product?.sku ?? null,
      isBundle: product?.is_bundle ?? false,
      ordersPlaced: s.ordersPlaced,
      ordersResolved: s.ordersResolved,
      itemsSold: s.itemsSold,
      revenue: s.revenue,
      cogs: s.cogs,
      grossRevenue: s.grossRevenue,
      grossCogs: s.grossCogs,
      deliveryRate: (skuRates.ratesByProduct.get(productId) ?? skuRates.fallback).rate,
      grossProfit,
      adSpend,
      contributionProfit: grossProfit - adSpend,
      costMissing: !builtCostByProduct.has(productId),
      openMonthRate: s.openMonthRate,
      openMonthRateSourceMonth: s.openMonthRateSourceMonth,
    });
  }

  // Each product's share of the shared spend (see splitSharedAdSpend).
  const sharedShares = splitSharedAdSpend(sharedAdSpend, soldProductsByDay(lineItems, mode, from, to), await getSplitTargets());

  // Spend now lands on products whether or not they sold, so a product with ad
  // spend but no orders in the window still gets a (zero-sales) row - otherwise
  // its marketing would silently drop out of the table.
  for (const productId of new Set([...adByProduct.keys(), ...sharedShares.keys()])) {
    if (statsByProduct.has(productId)) continue;
    const product = productById.get(productId);
    if (!product) continue;
    const adSpend = adByProduct.get(productId) ?? 0;
    result.push({
      productId,
      name: product.name,
      sku: product.sku ?? null,
      isBundle: product.is_bundle ?? false,
      ordersPlaced: 0,
      ordersResolved: 0,
      itemsSold: 0,
      revenue: 0,
      cogs: 0,
      grossRevenue: 0,
      grossCogs: 0,
      deliveryRate: (skuRates.ratesByProduct.get(productId) ?? skuRates.fallback).rate,
      grossProfit: 0,
      adSpend,
      contributionProfit: -adSpend,
      costMissing: !builtCostByProduct.has(productId),
      openMonthRate: null,
      openMonthRateSourceMonth: null,
    });
  }
  for (const row of result) {
    let share = 0;
    for (const v of sharedShares.get(row.productId)?.values() ?? []) share += v;
    row.adSpend += share;
    row.contributionProfit -= share;
  }

  return {
    products: result.sort((a, b) => b.revenue - a.revenue),
    openMonthInfo: boundary ? { month: boundary } : null,
  };
}

// Flat list of every product for the Rollforward typeahead, labelled
// "Model — Color" so models with similarly-named colors stay distinguishable
// (collapsed to just the name when the color matches the model, which is the
// common case here).
export const getProductOptions = unstable_cache(computeProductOptions, ["product-options"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

async function computeProductOptions(): Promise<ProductOption[]> {
  const { data: products, error } = await supabase.from("products").select("id, name, sku, model_group_id");
  if (error) throw new Error(`Failed to load products: ${error.message}`);
  const { data: models, error: mErr } = await supabase.from("model_groups").select("id, name");
  if (mErr) throw new Error(`Failed to load model_groups: ${mErr.message}`);
  const modelName = new Map((models ?? []).map((m) => [m.id, m.name as string]));

  return (products ?? [])
    .map((p) => {
      const model = p.model_group_id ? modelName.get(p.model_group_id) ?? "?" : null;
      // Most SKUs are named identically to their model group, so "Model — Color"
      // would just repeat the same text - only append the color when it differs.
      const label = model && model.trim() !== p.name.trim() ? `${model} — ${p.name}` : p.name;
      const sku = p.sku && String(p.sku).trim() ? String(p.sku).trim() : null;
      return { id: p.id, label, sku };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Daily Volume/Rev/COGS/Gross/Marketing/Contribution for a single product
// across [from, to]. Mature months use each order's real outcome (stored
// revenue/cost_of_goods), exactly like getPerProductReport; in Performance the
// still-open month projects via the SKU's own delivery rate, while Actual never
// projects. Marketing is the product's ad spend that day (the total spend of every
// ad allocated to this product) plus its share of shared spend (General and
// multi-product ads - see splitSharedAdSpend), bucketed by the ad's own date. Returns one row per calendar day in range
// (zeros where idle).
export async function getProductDailyRollforward(
  productId: number,
  from: string,
  to: string,
  mode: PerProductMode = "performance"
): Promise<ProductDailyRollforward> {
  const { data: product, error: prodErr } = await supabase
    .from("products")
    .select("id, name")
    .eq("id", productId)
    .maybeSingle();
  if (prodErr) throw new Error(`Failed to load product: ${prodErr.message}`);
  if (!product) return { rows: [], deliveryRate: null, rateSourceMonth: null };

  // Open-month COGS uses this product's Product List BOM cost, matching
  // getPerProductReport and the real per-order engine (margin.ts).
  const builtCostByProduct = await getBuiltCostByProduct();
  const unitCost = builtCostByProduct.get(productId) ?? 0;

  // Actual never projects - it reports exactly what was recorded shipped.
  const boundary = mode === "actual" ? null : findOpenMonthBoundary(from, to, await getClosedMonths());
  // This product's own delivery rate: its last-mature-month rate, else its
  // calibrated rate, else the store-wide fallback (never a flat 50%). It both
  // projects the open month below and labels the delivered-volume reference line.
  const skuRates = await getSkuProjectionRates();
  const { rate: deliveryRate, sourceMonth: rateSourceMonth } =
    skuRates.ratesByProduct.get(productId) ?? skuRates.fallback;

  // One product over one window, both pushed into the query: effectiveDay
  // resolves to the order's own Shopify day in either mode (see actualReportDay),
  // so the window is a plain range on orders.egypt_day. Which of those lines
  // Actual actually books is still decided per line below.
  const lineItems = await fetchAllRows<{
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
  }>(
    supabase,
    "order_line_items",
    "id, quantity, unit_price, revenue, cost_of_goods, orders!inner(egypt_day, outcome, cancelled_at, courier, bosta_picked_up_day, movers_record_date, bosta_tracking_number)",
    (query) => query.eq("product_id", productId).gte("orders.egypt_day", from).lte("orders.egypt_day", to)
  );

  const byDate = new Map<string, { volume: number; revenue: number; cogs: number }>();
  for (const li of lineItems) {
    const order = li.orders;
    if (order?.cancelled_at) continue;
    const eDay = effectiveDay(order, mode);
    if (eDay === null || eDay < from || eDay > to) continue;
    // Shipped but not confirmed delivered - earns nothing in Actual, same as the
    // table above.
    if (mode === "actual" && order && actualDelivery(order) !== "delivered") continue;
    if (!byDate.has(eDay)) byDate.set(eDay, { volume: 0, revenue: 0, cogs: 0 });
    const day = byDate.get(eDay)!;
    day.volume += li.quantity ?? 0; // items sold, independent of the rate projection
    const isOpenMonth = boundary !== null && eDay >= boundary;
    if (isOpenMonth) {
      day.revenue += deliveryRate * (li.quantity * (li.unit_price ?? 0));
      day.cogs += deliveryRate * (unitCost * li.quantity);
    } else {
      day.revenue += li.revenue ?? 0;
      day.cogs += li.cost_of_goods ?? 0;
    }
  }

  // Ad spend allocated to this product per day (campaigns allocated to it via
  // the Analysis-by-Product popup), bucketed by the ad's own spend date.
  const adByDate = new Map<string, number>();
  const adRows = await fetchAllRows<{ spend: number; date: string }>(
    supabase,
    "ad_spend",
    "id, spend, date",
    (query) => query.eq("product_id", productId).gte("date", from).lte("date", to)
  );
  for (const r of adRows) adByDate.set(r.date, (adByDate.get(r.date) ?? 0) + Number(r.spend));

  // Plus this product's share of shared spend, split exactly as the All Products
  // table splits it (splitSharedAdSpend).
  const [sharedAdSpend, windowLines, splitTargets] = await Promise.all([
    getSharedAdSpend(from, to),
    getPerProductLineItems(from, to),
    getSplitTargets(),
  ]);
  const sharedByDay =
    splitSharedAdSpend(sharedAdSpend, soldProductsByDay(windowLines, mode, from, to), splitTargets).get(productId) ??
    new Map<string, number>();

  const rows: ProductDailyRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const rc = byDate.get(d) ?? { volume: 0, revenue: 0, cogs: 0 };
    const grossProfit = rc.revenue - rc.cogs;
    const adSpend = (adByDate.get(d) ?? 0) + (sharedByDay.get(d) ?? 0);
    rows.push({ date: d, volume: rc.volume, revenue: rc.revenue, cogs: rc.cogs, grossProfit, adSpend, contributionProfit: grossProfit - adSpend });
  }
  // Only surface a rate when this product actually had orders in the window;
  // otherwise the projection rate is meaningless (nothing to project). Actual
  // never surfaces one either: its volume is already what really shipped and
  // stuck, so a delivered-volume reference line would haircut it a second time.
  const showRate = byDate.size > 0 && mode !== "actual";
  return { rows, deliveryRate: showRate ? deliveryRate : null, rateSourceMonth: showRate ? rateSourceMonth : null };
}
