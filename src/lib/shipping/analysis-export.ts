import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { actualDelivery, reachedCustomer } from "./shared";
import type { ShippingCourier } from "./shared";

// Order-level backing for one cell of the Analysis tab's delivery-rate table:
// click a rate, get the orders it was computed from.
//
// Deliberately WIDER than the rate itself. The courier rows' denominator is only
// orders handed to a courier, but an export is for chasing things down, and the
// first question a soft month raises is "what never went out at all" - so
// never-shipped orders are included and labelled rather than omitted. That means
// the row count here is normally larger than a courier cell's denominator (and
// exactly equal to the whole-business cell's).

export type AnalysisExportStatus = "Delivered" | "Not delivered" | "In progress" | "Never handed to courier";

export type AnalysisExportRow = {
  orderNumber: string;
  placedOn: string;
  courier: string | null;
  status: AnalysisExportStatus;
  outcome: string | null;
  cancelled: boolean;
  totalPrice: number | null;
  governorate: string | null;
};

type OrderRow = {
  id: number;
  order_number: string;
  egypt_day: string | null;
  outcome: string | null;
  courier: string | null;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
  bosta_tracking_number: string | null;
  cancelled_at: string | null;
  total_price: number | null;
  governorate_shopify: string | null;
};

// Same three-way split the table's counts use (see isDelivered / isSettled in
// ./delivery-rate.ts): confirmed arrived, confirmed came back, or still unknown.
// "In progress" is the honest answer for a Bosta order the sync hasn't resolved
// AND for one recorded to a manual courier with no ship date - both are orders
// we can't yet say landed, which is exactly what makes them worth exporting.
function statusOf(o: OrderRow & { egypt_day: string }): AnalysisExportStatus {
  if (!o.courier) return "Never handed to courier";
  if (reachedCustomer(o)) return "Delivered";
  if (actualDelivery(o) === "returned") return "Not delivered";
  return "In progress";
}

/**
 * Every order placed in `month` (YYYY-MM), optionally narrowed to one courier
 * or one product - matching the row that was clicked.
 */
export async function getAnalysisExportRows(opts: {
  month: string;
  courier?: ShippingCourier | null;
  productId?: number | null;
}): Promise<AnalysisExportRow[]> {
  const monthStart = `${opts.month}-01`;
  // First of the next month, so the range is a half-open [start, end).
  const [y, m] = opts.month.split("-").map(Number);
  const monthEnd = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

  const select =
    "id, order_number, egypt_day, outcome, courier, bosta_picked_up_day, movers_record_date, bosta_tracking_number, cancelled_at, total_price, governorate_shopify";

  let orders: OrderRow[];
  if (opts.productId != null) {
    // Product rows are a line-item aggregate, so the orders are reached through
    // order_line_items. An order containing the product twice would come back
    // twice, hence the de-dupe by order id below.
    const lines = await fetchAllRows<{ order_id: number; orders: OrderRow | null }>(
      supabase,
      "order_line_items",
      `id, order_id, orders!inner(${select})`,
      (query) => query.eq("product_id", opts.productId!).gte("orders.egypt_day", monthStart).lt("orders.egypt_day", monthEnd)
    );
    const byId = new Map<number, OrderRow>();
    for (const line of lines) {
      if (line.orders) byId.set(line.orders.id, line.orders);
    }
    orders = [...byId.values()];
  } else {
    orders = await fetchAllRows<OrderRow>(supabase, "orders", select, (query) =>
      query.gte("egypt_day", monthStart).lt("egypt_day", monthEnd)
    );
  }

  // A courier row is about that courier only, so never-shipped orders aren't its
  // business - they belong to no courier. The whole-business, all-couriers and
  // per-product rows keep them, since there the question "what never went out"
  // does apply.
  if (opts.courier) {
    orders = orders.filter((o) => o.courier === opts.courier);
  }

  return orders
    .filter((o): o is OrderRow & { egypt_day: string } => o.egypt_day !== null)
    .map((o) => ({
      orderNumber: o.order_number,
      placedOn: o.egypt_day,
      courier: o.courier,
      status: statusOf(o),
      outcome: o.outcome,
      cancelled: o.cancelled_at !== null,
      totalPrice: o.total_price,
      governorate: o.governorate_shopify,
    }))
    .sort((a, b) => (a.placedOn === b.placedOn ? a.orderNumber.localeCompare(b.orderNumber) : a.placedOn < b.placedOn ? -1 : 1));
}

/** RFC-4180 CSV, BOM-prefixed so Excel reads the Arabic governorate names as UTF-8. */
export function toCsv(rows: AnalysisExportRow[]): string {
  const esc = (v: string | number | boolean | null) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Order Number", "Order Placed Date", "Status", "Courier", "Raw Outcome", "Cancelled", "Total Price", "Governorate"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [r.orderNumber, r.placedOn, r.status, r.courier ?? "", r.outcome ?? "", r.cancelled ? "YES" : "NO", r.totalPrice ?? "", r.governorate ?? ""]
        .map(esc)
        .join(",")
    );
  }
  return "﻿" + lines.join("\r\n");
}
