import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { getPerProductLineItems } from "@/lib/reports/pnl-data";
import { ACTUAL_RECORDING_START, COURIERS, actualDelivery, reachedCustomer } from "./shared";
import type { DeliveryRatesResult, MonthlyRate, OrderStatusMonth, ProductMonthlyRate, ShippingCourier } from "./shared";

// Delivery rate by month of PLACEMENT for the Shipping Orders → Analysis tab:
// the whole business, then all couriers combined, then one row per courier, then
// one per product. See the block comment on MonthlyRate in ./shared.ts for what
// each denominator means and why they are meant to differ.

// Same floor as MONTHLY_START in monthly-table.tsx: nothing before Jan 2026 is
// presented month-by-month. It matters here because the whole-business row
// counts every order, shipped or not, which would otherwise drag in a long tail
// of older months the courier rows have nothing to say about.
const ANALYSIS_START = "2026-01";

type OrderRow = {
  egypt_day: string;
  outcome: string | null;
  cancelled_at: string | null;
  courier: string | null;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
  bosta_tracking_number: string | null;
};

// Which single bucket an order belongs in for the status breakdown. Order
// matters and is deliberate:
//   * delivered and returned come first, because they are the only two states we
//     have positive proof of. An order that arrived and was then marked
//     cancelled still arrived - the goods and the cash moved.
//   * cancelled next: no proof it went anywhere, and the cancellation says why.
//   * never shipped: not cancelled, but nobody ever handed it over.
//   * in progress: a courier has it and hasn't told us how it ended.
// Every order matches exactly one, so the columns sum to the orders placed.
function statusOf(o: OrderRow): keyof Pick<OrderStatusMonth, "delivered" | "returned" | "cancelled" | "neverShipped" | "inProgress"> {
  if (isDelivered(o)) return "delivered";
  if (o.courier && actualDelivery(o) === "returned") return "returned";
  if (o.cancelled_at) return "cancelled";
  if (!o.courier) return "neverShipped";
  return "inProgress";
}

// "Delivered" is reachedCustomer throughout - the single definition the Income
// Statement's Delivery Rate row uses too, so no row on this page can ever claim
// more deliveries than the business row above it. Anything it can't confirm
// falls to inProgress below rather than being scored as a failure.
const isDelivered = reachedCustomer;

// Whether the order's story is over. Deliberately stricter than "has an
// outcome": a Quick Connect order carries no outcome at all and is settled the
// moment it is recorded, while a Bosta order the sync hasn't resolved is not.
// Anything neither delivered nor returned is still moving, so it sits in the
// denominator without being able to reach the numerator - which is what the
// "n open" count reports.
function isSettled(o: OrderRow): boolean {
  return isDelivered(o) || actualDelivery(o) === "returned";
}

function toRate(shipped: number, delivered: number): number | null {
  return shipped > 0 ? delivered / shipped : null;
}

// The rate for a courier/product cell. In-progress orders stay in the
// denominator, so a month with a backlog reads low and climbs as its orders
// land - never the other way round.
//
// But a cell where NOTHING has settled gets no rate at all, rather than 0%.
// Zero would assert we know every one of them failed; the truth is we know
// nothing about any of them yet. June's Quick Connect cell is exactly this - 135
// orders recorded to the courier with no ship date and no outcome, so 0 of 135
// are confirmed and "0.0%" would read as a total collapse next to a month the
// business row scores at 75%. The "n open" count carries the real story instead.
function cellRate(shipped: number, delivered: number, settled: number): number | null {
  if (settled === 0) return null;
  return toRate(shipped, delivered);
}

// Whether a month can carry a courier scorecard at all. Before shipment
// recording began (ACTUAL_RECORDING_START), a courier only ever got stamped onto
// an order by the RETURNS flow - a delivered order from that era still has no
// courier, because nobody recorded it. June is the proof: of its 205
// courier-bearing orders, 70 are recorded returns and 135 are strays with no
// outcome, and not one is a delivery. Scoring that denominator would print
// "Turbo June: 0.0%" - a statement about which orders got recorded, not about
// how Turbo performed.
//
// The whole-business row is unaffected and still covers every month: its
// denominator is every order that came in, which is real data throughout, and
// its numerator falls back to Bosta's own delivered outcome for that window.
function courierScorecardApplies(month: string): boolean {
  const [y, m] = month.split("-").map(Number);
  const monthEnd = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return monthEnd > ACTUAL_RECORDING_START;
}

export async function getDeliveryRates(): Promise<DeliveryRatesResult> {
  // Cancellation is deliberately NOT filtered out. The recording flow refuses to
  // hand a cancelled order to a courier, so a cancelled order that HAS one was
  // shipped first and cancelled afterwards - which is what a refusal at the door
  // looks like. That is a delivery the courier failed to make, so it belongs in
  // the denominator; excluding it flattered the rate. It still only reaches the
  // numerator if its outcome says it actually arrived.
  const orders = await fetchAllRows<OrderRow>(
    supabase,
    "orders",
    "id, egypt_day, outcome, cancelled_at, courier, bosta_picked_up_day, movers_record_date, bosta_tracking_number"
  );

  const months = new Set<string>();
  type Tally = { shipped: number; delivered: number; inProgress: number };
  const overall = new Map<string, Tally>();
  const byCourier = new Map<ShippingCourier, Map<string, Tally>>();
  // Whole-business tally: every order, shipped or not. Kept separate from
  // `overall` because that one is a courier scorecard and deliberately ignores
  // orders nobody handed over.
  const business = new Map<string, { received: number; delivered: number }>();
  const status = new Map<string, OrderStatusMonth>();

  for (const o of orders) {
    if (!o.egypt_day) continue;
    const month = o.egypt_day.slice(0, 7);
    if (month < ANALYSIS_START) continue;

    // Counted before the courier check below, so orders that never reached a
    // courier still count against the business-wide rate.
    months.add(month);

    // The complete account of the month: every order lands in exactly one
    // bucket, cancellations and never-shipped included.
    const s =
      status.get(month) ??
      ({ month, placed: 0, delivered: 0, returned: 0, cancelled: 0, inProgress: 0, neverShipped: 0 } as OrderStatusMonth);
    s.placed++;
    s[statusOf(o)]++;
    status.set(month, s);

    const businessEntry = business.get(month) ?? { received: 0, delivered: 0 };
    businessEntry.received++;
    if (isDelivered(o)) businessEntry.delivered++;
    business.set(month, businessEntry);

    // No courier recorded = never handed to anyone, so it belongs in no
    // denominator below. Counting it would blame the couriers for orders they
    // were never given - and today that is 35,052 of 42,130 orders, which would
    // read as month after month of near-0%.
    const courier = o.courier;
    if (!courier) continue;
    if (!courierScorecardApplies(month)) continue; // pre-recording era - see above

    const delivered = isDelivered(o) ? 1 : 0;
    const open = isSettled(o) ? 0 : 1;

    const overallEntry = overall.get(month) ?? { shipped: 0, delivered: 0, inProgress: 0 };
    overallEntry.shipped++;
    overallEntry.delivered += delivered;
    overallEntry.inProgress += open;
    overall.set(month, overallEntry);

    const key = courier as ShippingCourier;
    if (!byCourier.has(key)) byCourier.set(key, new Map());
    const courierMonths = byCourier.get(key)!;
    const courierEntry = courierMonths.get(month) ?? { shipped: 0, delivered: 0, inProgress: 0 };
    courierEntry.shipped++;
    courierEntry.delivered += delivered;
    courierEntry.inProgress += open;
    courierMonths.set(month, courierEntry);
  }

  const sortedMonths = [...months].sort();

  const toMonthly = (month: string, v: Tally): MonthlyRate => ({
    month,
    shipped: v.shipped,
    delivered: v.delivered,
    inProgress: v.inProgress,
    rate: cellRate(v.shipped, v.delivered, v.shipped - v.inProgress),
  });

  return {
    months: sortedMonths,
    overallBusiness: sortedMonths.map((m) => {
      const v = business.get(m) ?? { received: 0, delivered: 0 };
      return { month: m, received: v.received, delivered: v.delivered, rate: toRate(v.received, v.delivered) };
    }),
    overall: sortedMonths.map((m) => toMonthly(m, overall.get(m) ?? { shipped: 0, delivered: 0, inProgress: 0 })),
    // In dropdown order, and only couriers that have actually shipped something.
    byCourier: COURIERS.filter((c) => byCourier.has(c.value)).map((c) => ({
      courier: c.value,
      byMonth: Object.fromEntries([...byCourier.get(c.value)!].map(([m, v]) => [m, toMonthly(m, v)])),
    })),
    // Newest month first - the one being watched is the one still moving.
    statusByMonth: sortedMonths.map((m) => status.get(m)!).reverse(),
  };
}

// Per-product, per-month delivered / shipped at order-line grain. Computed in
// TypeScript off the line-item scan the reports already make (request-memoized,
// so the Analysis tab usually pays nothing for it) rather than through a SQL
// function - 36 products over ~111k lines aggregates in memory without trouble,
// and it keeps this rate on the exact same isDelivered as every row above.
export async function getProductMonthlyRates(): Promise<ProductMonthlyRate[]> {
  const { data: products, error } = await supabase.from("products").select("id, name");
  if (error) throw new Error(`Failed to load products: ${error.message}`);
  const nameById = new Map((products ?? []).map((p) => [p.id as number, p.name as string]));

  // Every month from ANALYSIS_START on, not a reporting window: this table is
  // the per-product, per-month history itself. `to` is open-ended rather than
  // "today" so an order dated ahead of the clock still lands in its own month.
  const lineItems = await getPerProductLineItems(`${ANALYSIS_START}-01`, "9999-12-31");

  const byProduct = new Map<number, Map<string, { shipped: number; delivered: number; settled: number }>>();
  for (const li of lineItems) {
    const order = li.orders;
    if (!li.product_id || !order?.egypt_day) continue;
    // Same denominator as the courier rows: only lines whose order actually
    // reached a courier. Cancellations stay in, for the reason above.
    if (!order.courier) continue;
    const month = order.egypt_day.slice(0, 7);
    if (month < ANALYSIS_START) continue;
    if (!courierScorecardApplies(month)) continue; // pre-recording era - see above

    if (!byProduct.has(li.product_id)) byProduct.set(li.product_id, new Map());
    const months = byProduct.get(li.product_id)!;
    const entry = months.get(month) ?? { shipped: 0, delivered: 0, settled: 0 };
    entry.shipped++;
    if (isDelivered(order)) entry.delivered++;
    if (isSettled(order)) entry.settled++; // see cellRate - an all-unsettled cell gets no rate
    months.set(month, entry);
  }

  const rates: ProductMonthlyRate[] = [...byProduct].map(([productId, months]) => ({
    productId,
    name: nameById.get(productId) ?? `#${productId}`,
    byMonth: Object.fromEntries(
      [...months].map(([m, v]) => [
        m,
        { shipped: v.shipped, delivered: v.delivered, rate: cellRate(v.shipped, v.delivered, v.settled) },
      ])
    ),
  }));

  // Busiest products first - the ones whose rate actually moves the business.
  const totalShipped = (p: ProductMonthlyRate) => Object.values(p.byMonth).reduce((s, x) => s + x.shipped, 0);
  return rates.sort((a, b) => totalShipped(b) - totalShipped(a));
}
