import "server-only";
import { supabase } from "@/lib/supabase";
import { egyptToday } from "@/lib/dates";
import { normalizeOrderNumber, actualShipDay } from "./shared";
import type { ShippingCourier, BulkRecordSummary, ShipperSummary } from "./shared";

export type { ShippingCourier, BulkRecordSummary, ShipperSummary } from "./shared";

// Which orders shipped, and when, comes from Shopify: Khazenly fulfils each
// order there, and the order sync stamps courier + handover day + outcome from
// that fulfillment (src/lib/sync/shopify-orders.ts). The one thing recorded by
// hand is returns.

// Normalize + dedupe whatever the caller passes (a pasted blob or an array).
function toNumbers(raw: string[] | string): string[] {
  const arr = Array.isArray(raw) ? raw : raw.split(/[\s,;]+/);
  const seen = new Set<string>();
  for (const token of arr) {
    const t = token.trim();
    if (t) seen.add(normalizeOrderNumber(t));
  }
  return [...seen];
}

// Record returns from a pasted list of order numbers. An order with no Khazenly
// fulfillment in Shopify never shipped, so it can't be returned: it's reported
// (notShipped) and left untouched, instead of inventing a shipment for it.
//
// There is no date to pick. Each return is dated by the order's OWN shipped day
// (actualShipDay), so a return always lands on the day that order went out
// rather than on whenever the owner got round to keying it in - one batch can
// therefore write several different dates. That date is only read by the
// Inventory ledger (resolved_at, where it credits the stock back); the Income
// Statement dates a returned order by its Shopify day regardless.
//
// return_recorded_at is what keeps the upload in force: the Shopify sync leaves
// the outcome of such an order alone, even if Khazenly's fulfillment reads
// DELIVERED (a customer can send a parcel back after accepting it).
export async function bulkRecordReturns(rawNumbers: string[] | string, courier: ShippingCourier): Promise<BulkRecordSummary> {
  const numbers = toNumbers(rawNumbers);

  const summary: BulkRecordSummary = {
    courier,
    // Each return carries its own order's date, so there is no single batch date.
    date: egyptToday(),
    requested: numbers.length,
    matched: 0,
    alreadyRecorded: 0,
    notFound: [],
    cancelled: [],
    notShipped: [],
    recordedByCourier: [],
  };
  if (numbers.length === 0) return summary;

  const { data: found, error: findErr } = await supabase
    .from("orders")
    .select("id, order_number, courier, cancelled_at, outcome, return_recorded_at, egypt_day, bosta_picked_up_day, movers_record_date")
    .in("order_number", numbers);
  if (findErr) throw new Error(`Failed to look up orders: ${findErr.message}`);

  type FoundOrder = {
    id: number;
    order_number: string;
    courier: string | null;
    cancelled_at: string | null;
    outcome: string | null;
    return_recorded_at: string | null;
    egypt_day: string;
    bosta_picked_up_day: string | null;
    movers_record_date: string | null;
  };
  const byNumber = new Map(((found ?? []) as FoundOrder[]).map((o) => [o.order_number, o]));
  // Order ids grouped by the date their return should carry, so each distinct
  // day costs one update rather than one per order.
  const idsByDate = new Map<string, number[]>();
  let toUpdateCount = 0;
  for (const num of numbers) {
    const order = byNumber.get(num);
    if (!order) {
      summary.notFound.push(num);
      continue;
    }
    if (order.cancelled_at) {
      summary.cancelled.push(num);
      continue;
    }
    const day = actualShipDay(order);
    if (!order.courier || day === null) {
      summary.notShipped.push(num);
      continue;
    }
    if (order.return_recorded_at) summary.alreadyRecorded++;
    const bucket = idsByDate.get(day);
    if (bucket) bucket.push(order.id);
    else idsByDate.set(day, [order.id]);
    toUpdateCount++;
  }

  const now = new Date().toISOString();
  for (const [day, ids] of idsByDate) {
    const { error: updErr } = await supabase
      .from("orders")
      .update({ outcome: "failed_rto", resolved_at: day, cod_amount_collected: null, return_recorded_at: now, updated_at: now })
      .in("id", ids);
    if (updErr) throw new Error(`Failed to record returns: ${updErr.message}`);
  }

  summary.matched = toUpdateCount;
  if (toUpdateCount > 0) summary.recordedByCourier = [{ courier, count: toUpdateCount }];
  return summary;
}

async function countOrders(courier: ShippingCourier, outcome?: string): Promise<number> {
  let query = supabase.from("orders").select("id", { count: "exact", head: true }).eq("courier", courier);
  if (outcome) query = query.eq("outcome", outcome);
  const { count, error } = await query;
  if (error) throw new Error(`Failed to count ${courier} orders: ${error.message}`);
  return count ?? 0;
}

// Per-courier headline: orders Khazenly shipped, how many came back, and the
// delivery rate delivered / (delivered + returned) - parcels still on the road
// are excluded rather than counted as failures (same as the monthly rate engine,
// src/lib/engine/monthly-rate.ts).
export async function getShipperSummary(courier: ShippingCourier): Promise<ShipperSummary> {
  const [orders, delivered, returned] = await Promise.all([
    countOrders(courier),
    countOrders(courier, "delivered"),
    countOrders(courier, "failed_rto"),
  ]);
  const resolved = delivered + returned;
  return { courier, orders, delivered, returned, deliveryRate: resolved > 0 ? delivered / resolved : null };
}
