// Client-safe shipping helpers and types - no server-only / supabase imports,
// so the Shipping Orders form (a client component) can use them. The actual
// data access lives in src/lib/shipping/orders.ts (server-only).

// NUMA has exactly one courier. Khazenly writes each parcel's status back onto
// the Shopify fulfillment, so the Shopify order sync (src/lib/sync/shopify-orders.ts)
// stamps courier, handover day, tracking number and outcome itself - nothing is
// recorded by hand except returns.
export type ShippingCourier = "khazenly";

export const COURIERS: { value: ShippingCourier; label: string }[] = [{ value: "khazenly", label: "Khazenly" }];

export function isShippingCourier(value: unknown): value is ShippingCourier {
  return value === "khazenly";
}

// Couriers whose returns are uploaded by hand.
export const RETURN_COURIERS: { value: ShippingCourier; label: string }[] = COURIERS;

const COURIER_LABELS: Record<ShippingCourier, string> = {
  khazenly: "Khazenly",
};

// Where the Actual views start. Kept from the fork, where it marked the day the
// owner began recording shipments by hand and everything earlier fell back to a
// legacy rule. NUMA never had that gap - every order since the sync floor carries
// its Shopify fulfillment - so this sits at the sync floor and the legacy branch
// in actualShipDay never fires.
export const ACTUAL_RECORDING_START = "2026-01-01";

// Which day an order counts on in the Actual views, or null if it doesn't count
// at all. The single source of truth for "what did we really ship", shared by the
// Income Statement (src/lib/reports/daily-pnl.ts) and Analysis by Product
// (src/lib/reports/per-product.ts) so the two can never drift apart again.
//
// An order has shipped once Shopify shows a Khazenly fulfillment for it, and it
// is dated by that fulfillment's day (bosta_picked_up_day - the column name is
// inherited, see migration 0076). movers_record_date is no longer written; it
// stays in the signature only because every caller already selects it.
export function actualShipDay(order: {
  egypt_day: string;
  outcome: string | null;
  courier: string | null;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
}): string | null {
  if (order.courier === "khazenly" && order.bosta_picked_up_day) return order.bosta_picked_up_day;
  // Before ACTUAL_RECORDING_START (i.e. never, for NUMA - see above).
  if (order.egypt_day < ACTUAL_RECORDING_START) return order.outcome === "delivered" ? order.egypt_day : null;
  return null; // no fulfillment yet - not shipped
}

// Which day an order counts on in the Actual REPORTS (Income Statement and
// Analysis by Product) - always the Shopify order day, never the handover day.
//
// A month in Actual means "orders PLACED that month that were eventually
// shipped", a cohort view: the revenue sits with the demand that generated it,
// not with whenever the courier happened to collect - dating by the handover day
// would split a month's orders across two months whenever handover crossed the
// boundary.
//
// Inclusion still delegates to actualShipDay - an order only counts once
// Khazenly has it. Only the DATE differs, which is why this wraps that function
// rather than restating its rules.
//
// Note the deliberate split: actualShipDay stays the physical-handover date and
// is what fee/mix logic must keep using (src/lib/shipping/fees.ts weights the
// courier blend by real handovers). Don't collapse the two.
export function actualReportDay(order: {
  egypt_day: string;
  outcome: string | null;
  courier: string | null;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
}): string | null {
  return actualShipDay(order) === null ? null : order.egypt_day;
}

// Resolved outcomes where the goods came back instead of staying sold.
export const RETURNED_OUTCOMES = ["failed_rto", "exchange", "pickup_return"];

// Whether an order in Actual is confirmed to have REACHED the customer. Actual
// books revenue, COGS, items and packaging only on "delivered" - a month's
// revenue is the orders placed that month that actually landed, not merely the
// ones handed to a courier.
//
// Every Khazenly parcel is tracked - Khazenly marks it DELIVERED on the Shopify
// fulfillment when it lands - so `outcome` is the whole answer: silence just means
// it hasn't resolved yet, never "arrived". A return uploaded by hand overrides
// the fulfillment status (see return_recorded_at, migration 0076).
export type ActualDelivery = "delivered" | "returned" | "unconfirmed";

export function actualDelivery(order: {
  outcome: string | null;
  courier: string | null;
  bosta_tracking_number: string | null;
}): ActualDelivery {
  if (RETURNED_OUTCOMES.includes(order.outcome ?? "")) return "returned";
  if (order.outcome === "delivered") return "delivered";
  return "unconfirmed";
}

// Whether an order actually reached a customer, asked of ANY order in the book -
// shipped or not. This is the whole-business delivery test behind the Income
// Statement's Delivery Rate row and the rate the still-open month is projected
// with (src/lib/engine/monthly-rate.ts).
//
// It wraps actualDelivery rather than being it: actualDelivery answers "did this
// SHIPMENT land", and requiring actualShipDay first guarantees an order no
// courier ever held cannot count as delivered - it counts against the rate.
export function reachedCustomer(order: {
  egypt_day: string;
  outcome: string | null;
  courier: string | null;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
  bosta_tracking_number: string | null;
}): boolean {
  if (actualShipDay(order) === null) return false;
  return actualDelivery(order) === "delivered";
}

export function courierLabel(value: string | null): string {
  if (!value) return "—";
  return COURIER_LABELS[value as ShippingCourier] ?? value;
}

// Shopify order numbers carry a leading "#" (e.g. "#4756"). Normalize so the
// user can paste with or without it and lookups still match.
export function normalizeOrderNumber(input: string): string {
  const t = input.trim();
  return t.startsWith("#") ? t : `#${t}`;
}

// Splits a pasted blob on any whitespace/comma/semicolon, normalizes each, and
// dedupes - so the user can paste a column straight out of a sheet.
export function parseOrderNumbers(raw: string): string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,;]+/)) {
    const t = token.trim();
    if (t) seen.add(normalizeOrderNumber(t));
  }
  return [...seen];
}

export type BulkRecordSummary = {
  courier: ShippingCourier;
  date: string;
  requested: number;
  matched: number;
  alreadyRecorded: number;
  notFound: string[];
  cancelled: string[];
  notShipped: string[]; // order has no Khazenly fulfillment in Shopify, so it isn't recorded as a return
  recordedByCourier: { courier: ShippingCourier; count: number }[]; // how many returns landed on each courier
};

export type ShipperSummary = {
  courier: ShippingCourier;
  orders: number; // recorded orders for this courier ("Shipped")
  delivered: number;
  returned: number;
  deliveryRate: number | null; // delivered / (delivered + returned), null if none resolved yet
};

// --- Analysis tab: delivery rate by month of placement -----------------------
// Bucketed by the day each order was PLACED (orders.egypt_day - what Performance
// mode uses), not by when it shipped, so a month's rate answers "of what came in
// that month, how much arrived" and climbs as the month settles.
//
// Two different questions share the month axis, and they are meant to disagree:
// the whole-business row divides by every order, the courier rows divide by the
// orders that courier was actually given. Hand Khazenly 50 of March's 100
// orders and it delivers 40, and its March rate is 80% while the business reads
// 40%. The 50 nobody shipped are the storefront's problem, not the courier's.

export type MonthlyRate = {
  month: string; // "YYYY-MM"
  shipped: number; // orders handed to this courier - the denominator
  delivered: number;
  // Handed over that month but not confirmed either way yet, so the rate can
  // still move: a Khazenly parcel not yet marked delivered or returned. Counted in the denominator
  // rather than quietly dropped, so a month with a backlog reads honestly low
  // instead of falsely perfect.
  inProgress: number;
  rate: number | null; // delivered / shipped, null when nothing shipped
};

// One row per month for the whole business: delivered ÷ EVERY order that came in
// that month, cancellations included, so orders nobody ever shipped count
// against it. That is what makes it read lower than the courier rows beneath.
// Same figure as the Delivery Rate row on the monthly Income Statement, so the
// two screens agree.
export type BusinessMonthlyRate = {
  month: string; // "YYYY-MM"
  received: number; // every order placed that month, cancellations included
  delivered: number;
  rate: number | null; // delivered / received, null when nothing came in
};

// Where every order placed in a month ended up. One order lands in exactly one
// column and the five sum to `placed`, so a month reads as a complete account of
// itself: of the orders that came in, this many arrived, this many came back,
// this many were cancelled, this many are still moving, and this many nobody
// ever handed to a courier.
//
// Dated by the day the order was PLACED, never by when it shipped - the same
// basis the Actual Income Statement uses (see actualReportDay), so "August" here
// and "August" there mean the same set of orders.
export type OrderStatusMonth = {
  month: string; // "YYYY-MM"
  placed: number; // every order that came in that month, cancellations included
  delivered: number; // confirmed to have reached the customer
  returned: number; // came back (failed_rto / exchange / pickup_return)
  cancelled: number; // cancelled without ever being delivered or returned
  inProgress: number; // a courier has it, no confirmed outcome yet
  neverShipped: number; // no courier ever took it
};

// The whole-business row, the all-couriers row, then one row per courier,
// sharing a month axis - plus the status breakdown above, which walks the same
// orders and so is built in the same pass.
export type DeliveryRatesResult = {
  months: string[]; // ascending
  overallBusiness: BusinessMonthlyRate[];
  overall: MonthlyRate[];
  byCourier: { courier: ShippingCourier; byMonth: Record<string, MonthlyRate> }[];
  statusByMonth: OrderStatusMonth[];
};

export type ProductMonthlyRate = {
  productId: number;
  name: string;
  byMonth: Record<string, { shipped: number; delivered: number; rate: number | null }>;
};
