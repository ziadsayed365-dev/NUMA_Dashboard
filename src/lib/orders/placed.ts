// Whether an order counts as having been PLACED - the single test the P&L uses
// in place of a bare `cancelled_at` check.
//
// A cancellation only removes an order if it beat the courier. A return is
// routinely cancelled in Shopify AFTER the parcel comes back, and dropping those
// hid the return fee we really paid: 529 orders and roughly EGP 33k of courier
// cost across 2026, EGP 12.5k of it in March alone. An outcome or a Bosta
// tracking number is proof the order shipped, whatever Shopify says afterwards.
//
// Ported from the Launder project (src/lib/orders/placed.ts there), which hit
// the same problem first - keep the two in step, they are the same rule.
//
// What this deliberately does NOT admit: a cancelled order with no outcome and
// no tracking number (1,485 of them today, including 167 recorded to a manual
// courier). A manual-courier order carries no outcome and no tracking, so
// `actualDelivery` reads its silence as "delivered" - admitting those would book
// REVENUE on cancelled orders, which is the opposite of the intent here. Only
// positive evidence of what the courier did lets a cancelled order back in, and
// today every order that evidence admits is a return.

export type PlaceableOrder = {
  cancelled_at: string | null;
  outcome: string | null;
  bosta_tracking_number: string | null;
};

export function countsAsPlaced(order: PlaceableOrder): boolean {
  if (!order.cancelled_at) return true;
  return Boolean(order.outcome) || Boolean(order.bosta_tracking_number);
}
