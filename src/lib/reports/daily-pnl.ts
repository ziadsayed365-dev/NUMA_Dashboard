import "server-only";
import { unstable_cache } from "next/cache";
import { REPORT_CACHE_SECONDS, REPORT_CACHE_TAG } from "./cache";
import { supabase } from "@/lib/supabase";
import { firstOfMonth, addDays, daysInMonth } from "@/lib/dates";
import { getClosedMonths, getProjectionRate } from "@/lib/engine/monthly-rate";
import { getOpenMonthRows } from "./open-month-projection";
import { getMatureOrders, getAdSpendRows } from "./pnl-data";
import { actualReportDay, actualDelivery, reachedCustomer } from "@/lib/shipping/shared";
import { countsAsPlaced } from "@/lib/orders/placed";

export type DailyPnlRow = {
  date: string;
  ordersPlaced: number;
  ordersResolved: number;
  // The Delivery Rate row's denominator: every order Shopify took that period,
  // cancellations included. Deliberately wider than ordersPlaced (which drops
  // cancellations, since they contribute no revenue) and mode-INDEPENDENT, so
  // Performance and Actual share one denominator and can be read against each
  // other. The rate asks "of everything that came in, how much reached a
  // customer", so an order never shipped, never settled, or cancelled still
  // counts against it.
  ordersReceived: number;
  // The numerator: orders confirmed to have reached the customer (see
  // reachedCustomer). Mode-specific, since Actual only ever sees the orders it
  // reports on.
  ordersDelivered: number;
  itemsSold: number;
  revenue: number;
  cogs: number;
  // Revenue/COGS counting EVERY order in this mode's scope at full value, as if
  // 100% of them delivered - i.e. the basis the Meta dashboard reports on, which
  // knows nothing about returns. `revenue`/`cogs` above are the delivered basis
  // in BOTH modes now (a closed month removes its returns order by order, a
  // still-open month scales by the projected rate), so the two differ by exactly
  // the delivery haircut. This is the only place gross demand still lives, which
  // is why it stays unscaled. Only the Meta Dashboard ratio block reads these -
  // see buildLines in weekly-table.tsx.
  grossRevenue: number;
  grossCogs: number;
  grossProfit: number; // revenue - cogs
  adSpend: number; // total marketing (meta + tiktok + any other source)
  adSpendMeta: number; // Meta ads share of adSpend
  adSpendTiktok: number; // TikTok ads share of adSpend
  contributionProfit: number; // grossProfit - adSpend
  packaging: number;
  transportation: number; // flat settings.transportation_per_day average
  shippingFeeCharged: number; // shipping fee charged to the customer, expected-to-deliver share only
  bostaFeesPaid: number; // courier delivery fee + open package fee + COD cash ("next day") fee, expected-to-deliver share
  shippingDifferencesFee: number; // shippingFeeCharged - bostaFeesPaid
  salaries: number; // employee 1's flat monthly salary (spread over that month's real day count) + employee 2's revenue commission
  rent: number; // flat settings.rent_monthly spread over that month's real day count
  bostaPenalty: number; // cost of returned orders: real RTO fee+open package fee once resolved, or the estimated (1-rate) share while the month is still open
};

// Present when the requested range touches the still-open (immature)
// month, so the UI can disclose that those days are projected rather than
// real, and which month's rate is driving the projection.
export type OpenMonthInfo = {
  month: string;
  rate: number;
  sourceMonth: string | null;
};

export type DailyPnlTotals = DailyPnlRow extends infer R ? Omit<R, "date"> & { netProfit: number } : never;

// The most recent CLOSED month's real delivery rate, for the daily view. A
// single day's own rate is meaningless - that day's orders have had no time to
// be delivered but are all in its denominator, so every day would read near 0% -
// so the daily view shows this expected rate instead of each day's arithmetic.
// Same definition as the monthly Delivery Rate row, and the same rate the open
// month's money is projected with, so the row and the figures below it can never
// tell different stories.
export type ExpectedDeliveryRate = {
  rate: number | null;
  month: string | null; // the closed month it came from, "YYYY-MM"
};

export type DailyPnlResult = {
  rows: DailyPnlRow[]; // ascending by date
  totals: DailyPnlTotals;
  openMonthInfo: OpenMonthInfo | null;
  expectedDeliveryRate: ExpectedDeliveryRate;
};

const RESOLVED_OUTCOMES = ["delivered", "failed_rto", "exchange", "pickup_return"];

// "performance" = every Shopify order, whether or not it's shipped yet - the
// marketing/demand view. "actual" = the real shipped-sales view: the orders
// Khazenly has fulfilled in Shopify (see actualShipDay).
// Both which orders count and which day they land on differ by mode; Actual
// additionally takes no rate projection at all (see getDailyPnl).
//
// What no longer differs is the revenue test: NEITHER mode counts an order that
// came back. The modes are about which orders are in scope and how their courier
// cost is priced (blended vs the real courier's sheet), not about whether a
// return is a sale. Performance still reads higher than Actual because its scope
// is wider - it carries orders nobody ever shipped through to the Delivery Rate,
// and in the open month it projects with a rate instead of waiting for outcomes.
export type DailyPnlMode = "performance" | "actual";

// Which calendar day an order counts/dates on, and whether it counts at all.
// Both modes date by the Shopify order date (egypt_day); they differ in WHICH
// orders count. Performance takes every order. Actual defers to actualReportDay,
// which admits an order only once Khazenly has it (a fulfillment in Shopify) -
// then dates it by the day it was placed, so a month means "orders placed that
// month that were eventually shipped".
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

// Finds the earliest still-open month touching [from, to] - the point from
// which the projection takes over instead of real per-order data. Returns null
// if every month up to `to` has closed.
//
// "Closed" means the month ended AND every order a courier holds in it was
// decided, or the backstop has passed (see getClosedMonths) - not simply that 15
// days went by. A month with orders still in flight is reported as projected
// rather than final, and one whose orders all settled early stops being
// projected as soon as they do.
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

// `to` is the mature cut-off this call reports on; `fetchTo` is the upper bound
// the underlying order scan is keyed by, and may be wider.
//
// The two exist separately because the mature cut-off is mode-specific -
// Performance stops at the day before the open month, Actual runs to the end of
// the window - so keying the scan on it made the two modes miss each other in
// the shared() in-flight map and pull the whole order history twice, in
// parallel, for one page render. Both modes now scan on the same wider key and
// narrow in memory, which is identical work: the query filtered on egypt_day
// between from and to, and so does the filter below.
async function getMatureRows(
  from: string,
  to: string,
  mode: DailyPnlMode,
  fetchTo: string = to
): Promise<Map<string, DailyPnlRow>> {
  // Windowed on the Shopify order date regardless of mode, so the shared
  // ordersReceived denominator below sees every order. Actual drops the ones no
  // courier holds inside the loop instead, where it can count them first. Safe
  // because both modes date by egypt_day (see effectiveDay), so an order that
  // does count in Actual counts on this very day.
  const fetched = await getMatureOrders(from, fetchTo);
  const orders = fetchTo === to ? fetched : fetched.filter((o) => o.egypt_day <= to);

  const byDate = new Map<string, DailyPnlRow>();
  function getDay(date: string): DailyPnlRow {
    if (!byDate.has(date)) byDate.set(date, emptyRow(date));
    return byDate.get(date)!;
  }

  for (const order of orders) {
    // Counted before both skips below - a cancelled order, and an order never
    // handed to a courier, both still arrived - and identically in either mode,
    // so the two tabs share one Delivery Rate denominator.
    getDay(order.egypt_day).ordersReceived++;

    // Everything past this point is mode-specific: Actual reports only the
    // orders a courier actually holds.
    const reportDay = effectiveDay(order, mode);
    if (reportDay === null) continue;
    // A cancellation only removes an order if it beat the courier - see
    // countsAsPlaced. One cancelled after the parcel came back still cost us the
    // return fee, and that cost belongs on Bosta Penalty below. Its revenue does
    // not follow it in: margin.ts holds revenue and COGS at zero for any
    // cancelled order, so such an order contributes cost and nothing else.
    if (!countsAsPlaced(order)) continue;

    const day = getDay(reportDay);
    day.ordersPlaced++;
    const isResolved = RESOLVED_OUTCOMES.includes(order.outcome ?? "");
    if (isResolved) day.ordersResolved++;
    // The Delivery Rate numerator. Not the same question as isResolved: a
    // returned order is resolved but never reached anyone, and a Quick Connect
    // order that arrived carries no outcome at all to be resolved by.
    if (reachedCustomer(order)) day.ordersDelivered++;

    // A returned order never nets a shipping fee against Shipping
    // Differences Fee - its real courier + open package fee go to Bosta
    // Penalty instead. Asked of both modes now (it used to test only
    // `outcome === "failed_rto"` for Performance, which missed an exchange and a
    // pickup return), so the fee treatment matches the revenue test below: an
    // order that books no sale doesn't net a shipping fee either.
    // A cancelled order collected nothing either, whatever its outcome says -
    // the one shipped-then-cancelled order still sitting at in_transit is not a
    // return, so the test above would otherwise have credited it a fee it never
    // took. Mirrors the same guard in open-month-projection.ts.
    const delivery = actualDelivery(order);
    const chargesPenalty = delivery === "returned";
    if (!chargesPenalty && !order.cancelled_at) {
      day.shippingFeeCharged += order.shipping_fee_charged ?? 0;
    }

    // BOTH modes book revenue, COGS, items and packaging only once an order is
    // confirmed to have reached the customer. An order that came back earns
    // nothing (only the courier fee we really paid to ship and retrieve it, as
    // Bosta Penalty); one still in the courier's hands earns nothing YET, and
    // starts earning when it lands. It still pays its normal delivery fee below
    // either way - we handed it over and were billed for it.
    //
    // Performance used to count every order at full price here, which made the
    // same month read two different ways: while it was open the projection
    // scaled it by the delivery rate (returns excluded), and the moment it
    // closed this loop took over and put the returns back - August jumped EGP
    // 437k on closing, with nothing about the orders having changed. A month's
    // returns are known once it closes, so they are now removed order by order
    // rather than estimated by a rate.
    //
    // `reachedCustomer`, not `actualDelivery`, because only the former also
    // requires a courier to have held the order. Performance admits orders
    // nobody ever shipped (that is what makes its Delivery Rate read lower than
    // Actual's), and actualDelivery answers "delivered" for one of those - no
    // courier is not a manual courier and carries no Bosta tracking number, so
    // it falls into the "no return recorded" branch. In Actual the two are
    // equivalent, since effectiveDay has already required a courier above.
    //
    // The 100%-delivery basis is NOT lost: grossRevenue/grossCogs below stay
    // unscaled, and the Meta Dashboard ratio block reads those.
    const earnsRevenue = reachedCustomer(order);

    for (const li of order.order_line_items) {
      // The 100%-delivered basis: booked for every order in scope regardless of
      // outcome, since `revenue`/`cost_of_goods` are stored at full value (see
      // margin.ts) and are only held back below by the delivery test. No
      // refund/damage haircut here - those are the rate-weighted expectation of a
      // return, which by definition doesn't apply on a 100%-delivery basis.
      day.grossRevenue += li.revenue ?? 0;
      day.grossCogs += li.cost_of_goods ?? 0;
      if (earnsRevenue) {
        day.itemsSold += li.quantity ?? 0;
        day.revenue += li.revenue ?? 0;
        // Damage/refund risk is folded into COGS here (inventory-side loss).
        day.cogs += (li.cost_of_goods ?? 0) - (li.refund_adjustment ?? 0) - (li.damage_adjustment ?? 0);
        day.packaging += li.packing_cost ?? 0;
      }
      // Actual bills the sheet of the courier that really carried the order;
      // Performance bills the blended rate (see margin.ts). The blended column
      // already folds in the open-package and COD cash fees - both Bosta-only,
      // and so already weighted down by Bosta's share of the mix - which is why
      // it stands alone here instead of being added to the other two.
      const courierCost =
        mode === "actual"
          ? (li.allocated_courier_fee ?? 0) + (li.allocated_open_package_fee ?? 0) + (li.allocated_cod_cash_fee ?? 0)
          : (li.allocated_courier_fee_blended ?? 0);
      if (chargesPenalty) {
        // A return collects no COD, so no cash fee is in either figure to strip
        // out here - margin.ts leaves it at zero for every returned outcome.
        day.bostaPenalty += courierCost;
      } else {
        day.bostaFeesPaid += courierCost;
      }
    }
  }

  for (const day of byDate.values()) {
    day.shippingDifferencesFee = day.shippingFeeCharged - day.bostaFeesPaid;
  }

  return byDate;
}

// The dashboard asks for the whole history on every page load, and every page
// is force-dynamic, so without this each navigation and each refresh re-ran the
// entire report. The underlying data only moves when a sync runs, so a short
// window costs nothing in accuracy and takes the repeat cost to ~0. Arguments
// are part of the cache key, so each (from, to, mode) is cached separately.
export const getDailyPnl = unstable_cache(computeDailyPnl, ["daily-pnl"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

async function computeDailyPnl(from: string, to: string, mode: DailyPnlMode = "performance"): Promise<DailyPnlResult> {
  // Actual is the real shipped view: it uses each order's real per-order figures
  // for every month, including the still-open one - no rate projection.
  // (Performance still projects the open month.) So Actual reflects exactly the
  // shipments recorded in the Shipping Orders tab, nothing estimated.
  const boundary = mode === "actual" ? null : findOpenMonthBoundary(from, to, await getClosedMonths());
  const matureTo = boundary ? addDays(boundary, -1) : to;

  const byDate = new Map<string, DailyPnlRow>();
  let openMonthInfo: OpenMonthInfo | null = null;

  if (matureTo >= from) {
    // Scan keyed on the window's own end, not the mode's mature cut-off, so
    // Performance and Actual share one fetch - see getMatureRows.
    const matureRows = await getMatureRows(from, matureTo, mode, to);
    for (const [date, row] of matureRows) byDate.set(date, row);
  }

  if (boundary) {
    const openFrom = boundary > from ? boundary : from;
    const { rows: openRows, rate, sourceMonth } = await getOpenMonthRows(openFrom, to, mode);
    for (const row of openRows) byDate.set(row.date, row);
    openMonthInfo = { month: boundary, rate, sourceMonth };
  }

  const adSpendRows = await getAdSpendRows(from, to);
  for (const spend of adSpendRows) {
    if (!byDate.has(spend.date)) byDate.set(spend.date, emptyRow(spend.date));
    const row = byDate.get(spend.date)!;
    const amount = Number(spend.spend);
    row.adSpend += amount;
    if (spend.source === "tiktok") row.adSpendTiktok += amount;
    else row.adSpendMeta += amount; // meta (and any other source) rolls into the Meta line for now
  }

  const { data: settingsRow, error: settingsErr } = await supabase
    .from("settings")
    .select("rent_monthly, transportation_per_day, salary_employee1_monthly, salary_employee2_pct")
    .eq("id", 1)
    .single();
  if (settingsErr) throw new Error(`Failed to load settings: ${settingsErr.message}`);

  for (const day of byDate.values()) {
    day.grossProfit = day.revenue - day.cogs;
    day.contributionProfit = day.grossProfit - day.adSpend;
    // Employee 1's flat monthly salary spread over that specific calendar
    // month's real day count, plus employee 2's commission on that day's
    // revenue (real for a closed month, projected for the still-open
    // month - whichever day.revenue already reflects). Closed months will
    // get a different/refined calculation later; for now both use this
    // same formula uniformly. Rent gets the same real-day-count spread.
    day.salaries = settingsRow.salary_employee1_monthly / daysInMonth(day.date) + day.revenue * settingsRow.salary_employee2_pct;
    day.rent = settingsRow.rent_monthly / daysInMonth(day.date);
    day.transportation = settingsRow.transportation_per_day;
  }

  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)); // ascending

  const rowTotals = rows.reduce(
    (acc, r) => ({
      ordersPlaced: acc.ordersPlaced + r.ordersPlaced,
      ordersResolved: acc.ordersResolved + r.ordersResolved,
      ordersReceived: acc.ordersReceived + r.ordersReceived,
      ordersDelivered: acc.ordersDelivered + r.ordersDelivered,
      itemsSold: acc.itemsSold + r.itemsSold,
      revenue: acc.revenue + r.revenue,
      cogs: acc.cogs + r.cogs,
      grossRevenue: acc.grossRevenue + r.grossRevenue,
      grossCogs: acc.grossCogs + r.grossCogs,
      grossProfit: acc.grossProfit + r.grossProfit,
      adSpend: acc.adSpend + r.adSpend,
      adSpendMeta: acc.adSpendMeta + r.adSpendMeta,
      adSpendTiktok: acc.adSpendTiktok + r.adSpendTiktok,
      contributionProfit: acc.contributionProfit + r.contributionProfit,
      packaging: acc.packaging + r.packaging,
      transportation: acc.transportation + r.transportation,
      shippingFeeCharged: acc.shippingFeeCharged + r.shippingFeeCharged,
      bostaFeesPaid: acc.bostaFeesPaid + r.bostaFeesPaid,
      shippingDifferencesFee: acc.shippingDifferencesFee + r.shippingDifferencesFee,
      salaries: acc.salaries + r.salaries,
      rent: acc.rent + r.rent,
      bostaPenalty: acc.bostaPenalty + r.bostaPenalty,
    }),
    {
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
    }
  );

  const totals: DailyPnlTotals = {
    ...rowTotals,
    netProfit:
      rowTotals.contributionProfit -
      rowTotals.packaging -
      rowTotals.transportation -
      rowTotals.salaries -
      rowTotals.rent -
      rowTotals.bostaPenalty +
      rowTotals.shippingDifferencesFee,
  };

  return {
    rows,
    totals,
    openMonthInfo,
    // The same rate Performance projects its open month with, shown per-day in
    // place of each day's own (meaningless) arithmetic - so the row the daily
    // view shows and the money below it can never tell different stories. Actual
    // never projects, but still gets its own mode's rate as the benchmark to
    // read each day's real delivered/orders counts against.
    expectedDeliveryRate: await (async () => {
      const { rate, sourceMonth } = await getProjectionRate(mode);
      return { rate, month: sourceMonth ? sourceMonth.slice(0, 7) : null };
    })(),
  };
}
