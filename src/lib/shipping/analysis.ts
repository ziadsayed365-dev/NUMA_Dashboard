import "server-only";
import { supabase } from "@/lib/supabase";
import { courierLabel, type ShippingCourier } from "./shared";

// One row of the Shipping Orders → Analysis tab: how each company we ship
// through actually performed. Client-safe shape (the tab renders it directly).
export type ShippingAnalysisRow = {
  key: string;
  label: string;
  shipped: number; // orders handed over / recorded
  delivered: number;
  returned: number;
  inTransit: number; // still out with the courier - not yet delivered or returned
  deliveryRate: number | null; // null when nothing has resolved yet
  note: string;
};

async function countOrders(courier: ShippingCourier, outcome?: string | null): Promise<number> {
  let query = supabase.from("orders").select("id", { count: "exact", head: true }).eq("courier", courier).is("cancelled_at", null);
  if (outcome) query = query.eq("outcome", outcome);
  const { count, error } = await query;
  if (error) throw new Error(`Failed to count ${courier} orders: ${error.message}`);
  return count ?? 0;
}

// Khazenly reports each parcel's outcome on the Shopify fulfillment, so its rate
// is delivered / (delivered + returned) - the same definition the monthly rate
// engine uses (src/lib/engine/monthly-rate.ts). Parcels still on the road are
// excluded from the rate rather than counted as failures.
async function courierRow(courier: ShippingCourier): Promise<ShippingAnalysisRow> {
  const [shipped, delivered, returned] = await Promise.all([
    countOrders(courier),
    countOrders(courier, "delivered"),
    countOrders(courier, "failed_rto"),
  ]);
  const resolved = delivered + returned;
  return {
    key: courier,
    label: courierLabel(courier),
    shipped,
    delivered,
    returned,
    inTransit: Math.max(shipped - resolved, 0),
    deliveryRate: resolved > 0 ? delivered / resolved : null,
    note: "Status comes from Khazenly via Shopify, plus returns uploaded by hand. Parcels still on the road are left out of the rate.",
  };
}

// The Analysis tab's whole dataset: one row per company we ship through.
// Ordered by volume so the biggest shipper reads first.
export async function getShippingAnalysis(): Promise<ShippingAnalysisRow[]> {
  const rows = await Promise.all([courierRow("khazenly")]);
  return rows.sort((a, b) => b.shipped - a.shipped);
}
