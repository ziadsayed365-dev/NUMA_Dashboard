import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { COMPONENT_TYPES, type ComponentType, type ComponentUnit } from "@/lib/products/component-types";
import { getProductStructure } from "@/lib/products/final-products";
import { createBomExploder } from "@/lib/products/bom-explode";

// Purchasing "Report" tab data — COUNTS only (no cost). "Sent to the shipping
// company" = an order Khazenly has fulfilled in Shopify (courier = khazenly),
// whatever its outcome. Returns are included (outcome ignored); cancelled orders
// dropped. Each order is dated by its fulfillment day (bosta_picked_up_day, see
// migration 0076) — NOT the Shopify order day (egypt_day). The shipped line items
// are rolled up two ways:
//   - Table 1 (final products): units shipped per single product. Bundles are
//     decomposed into their member single products; bundles are never a row.
//   - Table 2 (components): quantity used (in the component's own g / ml / pc) per
//     raw material / packaging / other component consumed.

export type DayValue = { count: number };

export type ProductReportRow = {
  id: number;
  name: string;
  days: Record<string, DayValue>;
};

export type ComponentReportRow = {
  id: number;
  name: string;
  type: ComponentType;
  unit: ComponentUnit; // priced unit; the client maps it to the allocation label (g / ml / pc)
  days: Record<string, DayValue>;
};

export type ShipmentReport = {
  minDay: string | null;
  maxDay: string | null;
  products: ProductReportRow[];
  components: ComponentReportRow[];
};

// Shipped = Khazenly has the order (a fulfillment in Shopify). Returns
// are included; only cancelled orders are dropped. Dated by the day it was
// SHIPPED - its Khazenly fulfillment day in Shopify (bosta_picked_up_day, see
// migration 0076) - matching the Actual-mode
// effectiveDay rule the Income Statement uses (src/lib/reports/daily-pnl.ts). An
// order with no fulfillment yet is skipped.
function shipDay(
  order: {
    cancelled_at: string | null;
    courier: string | null;
    bosta_picked_up_day: string | null;
    movers_record_date: string | null;
  } | null
): string | null {
  if (!order || order.cancelled_at) return null;
  if (order.courier === "khazenly") return order.bosta_picked_up_day;
  return null;
}

function totalCount(row: { days: Record<string, DayValue> }): number {
  let sum = 0;
  for (const d of Object.values(row.days)) sum += d.count;
  return sum;
}

export async function getShipmentReport(): Promise<ShipmentReport> {
  const [structure, compRows] = await Promise.all([
    getProductStructure(),
    fetchAllRows<{ id: number; type: ComponentType; account: string; unit: ComponentUnit }>(
      supabase,
      "product_components",
      "id, type, account, unit"
    ),
  ]);

  const exploder = createBomExploder(structure);
  const compMeta = new Map(compRows.map((c) => [c.id, { name: c.account, type: c.type, unit: c.unit }]));

  const productAgg = new Map<number, { name: string; days: Map<string, DayValue> }>();
  const componentAgg = new Map<number, { days: Map<string, DayValue> }>();

  function addProduct(id: number, name: string, day: string, count: number) {
    let p = productAgg.get(id);
    if (!p) {
      p = { name, days: new Map() };
      productAgg.set(id, p);
    }
    const d = p.days.get(day) ?? { count: 0 };
    d.count += count;
    p.days.set(day, d);
  }

  function addComponent(id: number, day: string, qty: number) {
    let c = componentAgg.get(id);
    if (!c) {
      c = { days: new Map() };
      componentAgg.set(id, c);
    }
    const d = c.days.get(day) ?? { count: 0 };
    d.count += qty;
    c.days.set(day, d);
  }

  // Only pull line items of orders actually recorded against a courier (and not
  // cancelled). The !inner join + embedded filter pushes this to the database, so
  // we scan the shipped subset instead of every line item ever created.
  const lineItems = await fetchAllRows<{
    product_id: number | null;
    quantity: number;
    orders: {
      cancelled_at: string | null;
      courier: string | null;
      bosta_picked_up_day: string | null;
      movers_record_date: string | null;
    } | null;
  }>(
    supabase,
    "order_line_items",
    "product_id, quantity, orders!inner(cancelled_at, courier, bosta_picked_up_day, movers_record_date)",
    (q) => q.not("orders.courier", "is", null).is("orders.cancelled_at", null)
  );

  for (const li of lineItems) {
    const day = shipDay(li.orders);
    if (day === null) continue;
    const pid = li.product_id;
    if (pid == null) continue;
    const units = li.quantity ?? 0;
    if (units <= 0) continue;

    exploder.explode(
      pid,
      units,
      (singleId, name, u) => addProduct(singleId, name, day, u),
      (componentId, qty) => addComponent(componentId, day, qty)
    );
  }

  const allDays = new Set<string>();
  for (const p of productAgg.values()) for (const d of p.days.keys()) allDays.add(d);
  for (const c of componentAgg.values()) for (const d of c.days.keys()) allDays.add(d);
  const sorted = [...allDays].sort();

  const products: ProductReportRow[] = [...productAgg.entries()]
    .map(([id, p]) => ({ id, name: p.name, days: Object.fromEntries(p.days) }))
    .sort((a, b) => totalCount(b) - totalCount(a) || a.name.localeCompare(b.name));

  const components: ComponentReportRow[] = [...componentAgg.entries()]
    .map(([id, c]) => {
      const meta = compMeta.get(id);
      return {
        id,
        name: meta?.name ?? `#${id}`,
        type: meta?.type ?? ("other" as ComponentType),
        unit: meta?.unit ?? ("pcs" as ComponentUnit),
        days: Object.fromEntries(c.days),
      };
    })
    .sort(
      (a, b) => COMPONENT_TYPES.indexOf(a.type) - COMPONENT_TYPES.indexOf(b.type) || a.name.localeCompare(b.name)
    );

  return { minDay: sorted[0] ?? null, maxDay: sorted[sorted.length - 1] ?? null, products, components };
}
