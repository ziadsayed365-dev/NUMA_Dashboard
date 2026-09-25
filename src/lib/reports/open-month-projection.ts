import "server-only";
import { supabase } from "@/lib/supabase";
import { getOpenMonthOrders } from "./pnl-data";
import { normalizeGovernorate } from "@/lib/governorates";
import { getProjectionRate } from "@/lib/engine/monthly-rate";
import { getBuiltCostByProduct } from "@/lib/products/final-products";
import { getCourierFees } from "@/lib/shipping/fees";
import { actualReportDay, reachedCustomer } from "@/lib/shipping/shared";
import { countsAsPlaced } from "@/lib/orders/placed";
import type { DailyPnlMode, DailyPnlRow } from "./daily-pnl";

// Projects the still-open (immature) month's Income Statement using last
// month's store-wide delivery rate, uniformly across every included order -
// regardless of any individual order's real, already-known outcome. Which
// orders are included still depends on mode ("actual" requires a courier
// to have actually picked the order up; see the filter below) - only the
// figures for those orders are projected uniformly, not the inclusion test.
// Revenue, COGS, shipping fee charged, and the delivered-side Bosta fees
// (courier + open package + COD cash) all scale by `rate` - the
// "delivered" share of each. The complementary `(1 - rate)` share of the
// courier RTO fee + open package fee goes into bostaPenalty instead,
// since a returned order never collects a shipping fee to net against
// (Shipping Differences Fee only applies to the expected-to-deliver
// share). These are working assumptions for the still-open month,
// corrected with real per-order data (src/lib/engine/margin.ts) once the
// month closes and syncs for real. Kept separate from margin.ts rather
// than overriding its per-order computation since this is
// reporting-only: the Analysis by Product page and the underlying
// order_line_items engine keep using real-or-per-order projected values
// exactly as before.

type Settings = {
  cod_cash_fee_pct: number;
  packing_cost_per_unit: number;
  default_box_size_tier: string;
  bosta_open_package_fee: number;
  bosta_open_package_vat_pct: number;
};

function emptyRow(date: string): DailyPnlRow {
  return {
    date,
    ordersPlaced: 0,
    ordersResolved: 0,
    ordersReceived: 0,
    ordersDelivered: 0,
    itemsSold: 0,
    revenue: 0,
    cogs: 0,
    grossRevenue: 0,
    grossCogs: 0,
    grossProfit: 0,
    adSpend: 0,
    adSpendMeta: 0,
    adSpendTiktok: 0,
    contributionProfit: 0,
    packaging: 0,
    transportation: 0,
    shippingFeeCharged: 0,
    bostaFeesPaid: 0,
    shippingDifferencesFee: 0,
    salaries: 0,
    rent: 0,
    bostaPenalty: 0,
  };
}

const RESOLVED_OUTCOMES = ["delivered", "failed_rto", "exchange", "pickup_return"];

// Same rule as daily-pnl.ts's effectiveDay, delegating to the shared helper so
// the two can't drift: both modes date by the Shopify order date, and Actual
// additionally requires Khazenly to hold the order (a fulfillment in Shopify).
// An order with no fulfillment is excluded from Actual entirely - not actually
// shipped yet.
//
// Actual never reaches here in practice (daily-pnl.ts passes boundary=null for
// Actual, and per-product projects in Performance only), but it stays correct
// rather than divergent in case that changes.
function effectiveDay(
  r: {
    egypt_day: string;
    outcome: string | null;
    courier: string | null;
    bosta_picked_up_day: string | null;
    movers_record_date: string | null;
  },
  mode: DailyPnlMode
): string | null {
  if (mode === "performance") return r.egypt_day;
  return actualReportDay(r);
}

export async function getOpenMonthRows(
  from: string,
  to: string,
  mode: DailyPnlMode = "performance"
): Promise<{ rows: DailyPnlRow[]; rate: number; sourceMonth: string | null }> {
  // Mode-specific: Performance projects with delivered / every order received,
  // Actual with delivered / the orders a courier holds - matching the set of
  // orders each mode goes on to multiply, so neither is discounted twice.
  const { rate, sourceMonth } = await getProjectionRate(mode);

  const { data: settingsRow, error: settingsErr } = await supabase.from("settings").select("*").eq("id", 1).single();
  if (settingsErr || !settingsRow) throw new Error(`Failed to load settings: ${settingsErr?.message}`);
  const settings = settingsRow as Settings;
  const openPackageFeeTotal = settings.bosta_open_package_fee * (1 + settings.bosta_open_package_vat_pct);

  // Same fee model margin.ts uses for closed months, so the open month doesn't
  // price a shipment differently from the day it matures.
  const fees = await getCourierFees();

  // Cost of goods per product comes from the Product List BOM (single =
  // component build, bundle = contents roll-up), the same source margin.ts
  // uses for closed months - so the open-month projection and the real
  // per-order engine agree on unit cost. Laurel has no model groups, so the
  // old model_group unit_cost path always yielded 0 here.
  const builtCostByProduct = await getBuiltCostByProduct();

  // "actual" means Khazenly has actually picked up the order, regardless of
  // whether its real outcome is known yet. Applies
  // even in the still-open month, so Actual genuinely differs from
  // Performance instead of converging on the same blanket projection.
  // Windowed on the Shopify order date regardless of mode, matching
  // daily-pnl.ts's getMatureRows: the Delivery Rate denominator has to see every
  // order that came in, so the mode's inclusion test is applied inside the loop
  // instead, after that count is taken.
  const orders = await getOpenMonthOrders(from, to);

  const byDate = new Map<string, DailyPnlRow>();
  function getDay(date: string): DailyPnlRow {
    if (!byDate.has(date)) byDate.set(date, emptyRow(date));
    return byDate.get(date)!;
  }

  for (const order of orders) {
    // Counted before both skips below: a cancelled order, and one no courier
    // holds, both still arrived and both belong in the Delivery Rate denominator.
    getDay(order.egypt_day).ordersReceived++;

    const reportDay = effectiveDay(order, mode);
    if (reportDay === null) continue; // not in this mode (Actual: nobody has shipped it)
    // A cancellation only removes an order if it beat the courier - see
    // countsAsPlaced. One cancelled after the parcel came back still cost us the
    // return fee. Its revenue does not come in with it: margin.ts holds revenue
    // and COGS at zero for any cancelled order, and the unit_price path below is
    // guarded the same way, so it contributes cost and nothing else.
    if (!countsAsPlaced(order)) continue;

    const day = getDay(reportDay);
    day.ordersPlaced++;

    const isResolved = RESOLVED_OUTCOMES.includes(order.outcome ?? "");
    if (isResolved) day.ordersResolved++;
    // The money on these rows is projected from `rate`, but the delivered COUNT
    // is a plain fact and is reported as-is - it's what makes the open month's
    // Delivery Rate row read true rather than a flat 0%.
    if (reachedCustomer(order)) day.ordersDelivered++;
    // Only the expected-to-deliver share of shipping revenue counts here -
    // a returned order never nets against Shipping Differences Fee, and a
    // shipped-then-cancelled order is a return we already know about, so it
    // collects nothing at all.
    if (!order.cancelled_at) day.shippingFeeCharged += rate * (order.shipping_fee_charged ?? 0);

    const governorate = normalizeGovernorate(order.outcome_governorate) ?? normalizeGovernorate(order.governorate_shopify);

    const codBasis = order.cod_amount_collected ?? order.total_price ?? 0;
    const codCashFeeTotal = codBasis * settings.cod_cash_fee_pct;

    const lineItems = order.order_line_items ?? [];
    const totalItemsInOrder = lineItems.reduce((sum, li) => sum + li.quantity, 0);

    // Actual prices the order on the sheet of the courier that really carried
    // it. Performance is the "as-if-shipped" demand view, so it prices every
    // order at the blended rate - each priced courier's fee weighted by the
    // trailing shipment mix - and a day's shipping economics no longer swing on
    // how many of its orders happen to be recorded to which courier yet.
    const resolved = (delivered: boolean) =>
      mode === "actual" ? fees.actual(order.courier, governorate, delivered) : fees.blended(governorate, delivered);
    const deliveredFee = resolved(true);
    const returnedFee = resolved(false);
    // No Khazenly price sheet yet (either mode), or - in Actual - nothing has
    // shipped the order. Keeps the break-even placeholder - the Shopify shipping
    // fee charged - so its Shipping Differences nets to zero rather than
    // inventing a cost.
    const isUnpriced = deliveredFee === null;
    const bostaShare = deliveredFee?.bostaShare ?? 0;

    // Returns the full (per-order) fee - callers apply each line item's unitShare.
    function feeFor(outcome: string): number {
      return (outcome === "delivered" ? deliveredFee! : returnedFee!).fee;
    }

    for (const li of lineItems) {
      const unitCost = li.product_id != null ? builtCostByProduct.get(li.product_id) ?? 0 : 0;
      const unitShare = totalItemsInOrder > 0 ? li.quantity / totalItemsInOrder : 0;

      const revenue = li.quantity * li.unit_price;
      const costOfGoods = unitCost * li.quantity;
      const packing = settings.packing_cost_per_unit * li.quantity;
      const shippingFeeShare = (order.shipping_fee_charged ?? 0) * unitShare;
      // The settings' open-package and COD cash fees are Bosta-era charges -
      // 0 for Khazenly until its equivalents are known (see fees.ts).
      const codCashFeeShare = codCashFeeTotal * unitShare * bostaShare;
      const openPackageFeeShare = openPackageFeeTotal * unitShare * bostaShare; // outcome-invariant, charged every attempt

      const courierFeeDelivered = isUnpriced ? shippingFeeShare : feeFor("delivered") * unitShare;
      const courierFeeFailed = isUnpriced ? shippingFeeShare : feeFor("failed_rto") * unitShare;

      // A cancelled order that already shipped is in this month for one reason:
      // the return fee it cost us. Nothing about it is uncertain, so it takes
      // none of the rate split below - it books the full return fee and no
      // revenue, no COGS, no items, no packaging. The guard has to live here
      // rather than rely on margin.ts's zero, because this branch prices revenue
      // from unit_price directly and never reads the `revenue` column.
      if (order.cancelled_at) {
        day.bostaPenalty += courierFeeFailed + openPackageFeeShare;
        continue;
      }

      // Revenue and COGS scale by rate the same way (full value for the
      // delivered share, zero for the rest - an RTO'd order collects no
      // cash, and the inventory comes back rather than being lost,
      // matching margin.ts's failedMargin which never subtracts
      // costOfGoods either). Open package fee is owed either way, so it
      // splits proportionally between the two buckets; COD cash fee only
      // ever applies to the delivered share.
      day.itemsSold += li.quantity;
      day.revenue += rate * revenue;
      day.cogs += rate * costOfGoods;
      // The 100%-delivery basis stays UNSCALED - it is the same money the Meta
      // dashboard reports, which counts every order as if it landed.
      day.grossRevenue += revenue;
      day.grossCogs += costOfGoods;
      day.packaging += packing;
      day.bostaFeesPaid += rate * (courierFeeDelivered + openPackageFeeShare + codCashFeeShare);
      day.bostaPenalty += (1 - rate) * (courierFeeFailed + openPackageFeeShare);
    }
  }

  for (const day of byDate.values()) {
    day.grossProfit = day.revenue - day.cogs;
    day.contributionProfit = day.grossProfit - day.adSpend;
    day.shippingDifferencesFee = day.shippingFeeCharged - day.bostaFeesPaid;
  }

  return { rows: [...byDate.values()], rate, sourceMonth };
}
