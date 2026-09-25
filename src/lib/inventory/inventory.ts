import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { addDays, egyptDayOf, egyptToday, firstOfNextMonth } from "@/lib/dates";
import { COMPONENT_TYPES, UNIT_DIVISOR, type ComponentType, type ComponentUnit } from "@/lib/products/component-types";
import { getProductStructure } from "@/lib/products/final-products";
import { createBomExploder } from "@/lib/products/bom-explode";

// Purchasing → Inventory. A stock ledger day by day, in the PRICED unit
// (KG / L / Pcs):
//
//   ending = beginning + purchases + returns - orders +/- adjustments
//
// beginning on the start date is the owner's counted opening balance; every day
// after that, beginning = the previous day's ending.
//
// A ledger line is an ITEM, not necessarily a component. Components that belong
// to an inventory_group are counted together as one line - the seven essential
// oil scents read as a single "Essential oil" balance - because that is how the
// stock is physically counted. Everything else is its own line. The components
// stay separate for costing; this is a counting view only.
//
// The server returns each item's opening balance plus SPARSE per-day movements
// (only days something actually moved). The client carries the balance forward,
// which keeps the payload proportional to activity rather than elapsed days.

// Outcomes that put physical stock back on the shelf. "exchange" is deliberately
// absent: the customer keeps goods and swaps them, so it isn't a net return.
const RETURN_OUTCOMES = new Set(["failed_rto", "pickup_return", "cancelled_return"]);

export type ItemKind = "group" | "component";
export type ItemRef = { kind: ItemKind; id: number };

// Stable string form of an ItemRef, used as a map key and as the React key.
export function itemKey(ref: ItemRef): string {
  return `${ref.kind}:${ref.id}`;
}

export type InventoryMovement = {
  purchases: number; // + bought into stock (purchases tab)
  returns: number; // + came back from a courier
  orders: number; // - shipped to the courier
  adjustments: number; // +/- typed in by hand: wastage, breakage, samples, recount corrections
};

export type InventoryItemRow = {
  key: string;
  kind: ItemKind;
  id: number;
  name: string;
  type: ComponentType; // a group takes its members' type, for the section headings
  unit: ComponentUnit;
  memberNames: string[]; // non-empty only for a group, so the UI can show what's inside
  opening: number; // counted on-hand at startDate, in the priced unit
  days: Record<string, InventoryMovement>;
};

export type InventoryLedger = {
  startDate: string | null; // null until the owner sets it (Inventory not started)
  today: string;
  rows: InventoryItemRow[];
};

// One line of the opening-balance / adjustment pickers.
export type InventoryItem = {
  key: string;
  kind: ItemKind;
  id: number;
  name: string;
  type: ComponentType;
  unit: ComponentUnit;
  memberNames: string[];
  quantity: number; // saved opening balance (0 if never entered)
};

function emptyMovement(): InventoryMovement {
  return { purchases: 0, returns: 0, orders: 0, adjustments: 0 };
}

// The ledger line a hand-entered adjustment belongs to. A row
// written against a component that has since joined a group follows it there.
function itemRefOf(
  row: { component_id: number | null; group_id: number | null },
  refOf: Map<number, ItemRef>
): ItemRef | null {
  if (row.group_id != null) return { kind: "group", id: row.group_id };
  if (row.component_id != null) return refOf.get(row.component_id) ?? { kind: "component", id: row.component_id };
  return null;
}

type ComponentRow = {
  id: number;
  account: string;
  type: ComponentType;
  unit: ComponentUnit;
  inventory_group_id: number | null;
};
type GroupRow = { id: number; name: string; unit: ComponentUnit };

// Which day an order counts as SHIPPED on: the day of its Khazenly fulfillment
// in Shopify (bosta_picked_up_day, see migration 0076). Same rule as the Purchasing Report and the
// Actual income statement (actualShipDay) - stock physically left the warehouse
// that day, whatever the order's eventual outcome.
function shipDay(order: {
  cancelled_at: string | null;
  courier: string | null;
  bosta_picked_up_day: string | null;
  movers_record_date: string | null;
}): string | null {
  if (order.cancelled_at) return null;
  if (order.courier === "khazenly") return order.bosta_picked_up_day;
  return null;
}

async function loadItemModel(): Promise<{
  components: ComponentRow[];
  groups: GroupRow[];
  // component id -> the ledger line it belongs to
  refOf: Map<number, ItemRef>;
  items: Omit<InventoryItem, "quantity">[];
}> {
  const [components, groups] = await Promise.all([
    fetchAllRows<ComponentRow>(supabase, "product_components", "id, account, type, unit, inventory_group_id"),
    fetchAllRows<GroupRow>(supabase, "inventory_groups", "id, name, unit"),
  ]);

  const groupById = new Map(groups.map((g) => [g.id, g]));
  const membersOf = new Map<number, ComponentRow[]>();
  const refOf = new Map<number, ItemRef>();
  for (const c of components) {
    // A group id that no longer exists (or a unit mismatch) must not swallow the
    // component silently - it falls back to being its own line.
    const group = c.inventory_group_id == null ? undefined : groupById.get(c.inventory_group_id);
    if (group && group.unit === c.unit) {
      refOf.set(c.id, { kind: "group", id: group.id });
      membersOf.set(group.id, [...(membersOf.get(group.id) ?? []), c]);
    } else {
      refOf.set(c.id, { kind: "component", id: c.id });
    }
  }

  const items: Omit<InventoryItem, "quantity">[] = [
    ...groups
      .filter((g) => (membersOf.get(g.id)?.length ?? 0) > 0)
      .map((g) => {
        const members = membersOf.get(g.id)!;
        return {
          key: itemKey({ kind: "group" as const, id: g.id }),
          kind: "group" as const,
          id: g.id,
          name: g.name,
          type: members[0].type,
          unit: g.unit,
          memberNames: members.map((m) => m.account).sort((a, b) => a.localeCompare(b)),
        };
      }),
    ...components
      .filter((c) => refOf.get(c.id)?.kind === "component")
      .map((c) => ({
        key: itemKey({ kind: "component" as const, id: c.id }),
        kind: "component" as const,
        id: c.id,
        name: c.account,
        type: c.type,
        unit: c.unit,
        memberNames: [] as string[],
      })),
  ].sort((a, b) => COMPONENT_TYPES.indexOf(a.type) - COMPONENT_TYPES.indexOf(b.type) || a.name.localeCompare(b.name));

  return { components, groups, refOf, items };
}

export async function getInventorySettings(): Promise<{ startDate: string | null }> {
  const { data, error } = await supabase.from("inventory_settings").select("start_date").eq("id", 1).maybeSingle();
  if (error) throw new Error(`Failed to load inventory settings: ${error.message}`);
  return { startDate: (data?.start_date as string | undefined) ?? null };
}

type OpeningRow = { component_id: number | null; group_id: number | null; quantity: number };

function openingKeyOf(r: OpeningRow): string | null {
  if (r.group_id != null) return itemKey({ kind: "group", id: r.group_id });
  if (r.component_id != null) return itemKey({ kind: "component", id: r.component_id });
  return null;
}

// Every ledger line, with whatever opening balance was saved for it.
export async function getOpeningBalances(): Promise<{ startDate: string | null; rows: InventoryItem[] }> {
  const [{ startDate }, model, saved] = await Promise.all([
    getInventorySettings(),
    loadItemModel(),
    fetchAllRows<OpeningRow>(supabase, "inventory_opening_balances", "id, component_id, group_id, quantity"),
  ]);

  const byKey = new Map<string, number>();
  for (const r of saved) {
    const key = openingKeyOf(r);
    if (key) byKey.set(key, Number(r.quantity));
  }

  return { startDate, rows: model.items.map((i) => ({ ...i, quantity: byKey.get(i.key) ?? 0 })) };
}

// Sets the ledger's start date and the counted on-hand quantity of every line.
// Re-saving replaces both: the opening balance is a physical count, so the
// newest count is the truth.
export async function saveOpeningBalances(input: {
  startDate: string;
  balances: { kind: ItemKind; id: number; quantity: number }[];
}): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new Error("Invalid start date");
  for (const b of input.balances) {
    if (!Number.isFinite(b.id)) throw new Error("Invalid item");
    if (b.kind !== "group" && b.kind !== "component") throw new Error("Invalid item type");
    if (!Number.isFinite(b.quantity) || b.quantity < 0) throw new Error("Opening quantity must be zero or positive");
  }

  const now = new Date().toISOString();
  const { error: setErr } = await supabase
    .from("inventory_settings")
    .upsert({ id: 1, start_date: input.startDate, updated_at: now }, { onConflict: "id" });
  if (setErr) throw new Error(`Failed to save start date: ${setErr.message}`);

  // Wholesale replace: a row per line, and lines that no longer exist go away.
  const { error: delErr } = await supabase.from("inventory_opening_balances").delete().gte("id", 0);
  if (delErr) throw new Error(`Failed to clear opening balances: ${delErr.message}`);

  const rows = input.balances.map((b) => ({
    component_id: b.kind === "component" ? b.id : null,
    group_id: b.kind === "group" ? b.id : null,
    quantity: b.quantity,
    updated_at: now,
  }));
  if (rows.length === 0) return;

  const { error: balErr } = await supabase.from("inventory_opening_balances").insert(rows);
  if (balErr) throw new Error(`Failed to save opening balances: ${balErr.message}`);
}

// One editable cell of the (monthly) Adjustments row: the signed stock change for
// that ledger line over the month (-2 = two broken, +5 = five found on a
// recount). Re-saving replaces the whole month's figure (the cell shows a total,
// not a running list) and zero clears it. Stored as a single row dated the
// month's last day, so it lands inside that month and before the next one opens.
export async function saveInventoryAdjustment(input: {
  kind: ItemKind;
  id: number;
  month: string; // "YYYY-MM"
  quantity: number;
}): Promise<void> {
  if (!Number.isFinite(input.id)) throw new Error("Pick an item");
  if (input.kind !== "group" && input.kind !== "component") throw new Error("Invalid item type");
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new Error("Invalid month");
  if (!Number.isFinite(input.quantity)) throw new Error("Enter a number");

  const monthStart = `${input.month}-01`;
  const monthEnd = addDays(firstOfNextMonth(monthStart), -1);

  const { startDate } = await getInventorySettings();
  if (!startDate) throw new Error("Set the inventory start date first");
  if (monthEnd < startDate) throw new Error(`The ledger opens on ${startDate} - pick a later month`);

  const column = input.kind === "component" ? "component_id" : "group_id";
  const { error: delErr } = await supabase
    .from("inventory_adjustments")
    .delete()
    .gte("date", monthStart)
    .lte("date", monthEnd)
    .eq(column, input.id);
  if (delErr) throw new Error(`Failed to save adjustment: ${delErr.message}`);

  if (input.quantity === 0) return; // cleared

  const { error } = await supabase.from("inventory_adjustments").insert({
    date: monthEnd,
    component_id: input.kind === "component" ? input.id : null,
    group_id: input.kind === "group" ? input.id : null,
    kind: "delta",
    quantity: input.quantity,
  });
  if (error) throw new Error(`Failed to save adjustment: ${error.message}`);
}

// ---- Group management --------------------------------------------------
// Creating/editing a group is a counting decision, so it lives with Inventory
// rather than with the BOM. Members must share the group's unit - a balance
// mixing litres and pieces would be meaningless.
export async function saveInventoryGroup(input: {
  id: number | null;
  name: string;
  unit: ComponentUnit;
  componentIds: number[];
}): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error("Give the group a name");

  const components = await fetchAllRows<{ id: number; unit: ComponentUnit; account: string }>(
    supabase,
    "product_components",
    "id, unit, account"
  );
  const byId = new Map(components.map((c) => [c.id, c]));
  for (const id of input.componentIds) {
    const c = byId.get(id);
    if (!c) throw new Error("Unknown component");
    if (c.unit !== input.unit) throw new Error(`${c.account} is measured in ${c.unit}, not ${input.unit}`);
  }

  let groupId = input.id;
  const now = new Date().toISOString();
  if (groupId == null) {
    const { data, error } = await supabase
      .from("inventory_groups")
      .insert({ name, unit: input.unit })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to create group: ${error?.message}`);
    groupId = data.id as number;
  } else {
    const { error } = await supabase
      .from("inventory_groups")
      .update({ name, unit: input.unit, updated_at: now })
      .eq("id", groupId);
    if (error) throw new Error(`Failed to rename group: ${error.message}`);
  }

  // Members not in the new list go back to being their own ledger line.
  const { error: clearErr } = await supabase
    .from("product_components")
    .update({ inventory_group_id: null, updated_at: now })
    .eq("inventory_group_id", groupId);
  if (clearErr) throw new Error(`Failed to update group members: ${clearErr.message}`);

  if (input.componentIds.length > 0) {
    const { error: setErr } = await supabase
      .from("product_components")
      .update({ inventory_group_id: groupId, updated_at: now })
      .in("id", input.componentIds);
    if (setErr) throw new Error(`Failed to update group members: ${setErr.message}`);
  }
}

export async function deleteInventoryGroup(id: number): Promise<void> {
  // Members fall back to their own lines via ON DELETE SET NULL.
  const { error } = await supabase.from("inventory_groups").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete group: ${error.message}`);
}

// Every component plus the current groups, for the grouping editor.
export async function getGroupingModel(): Promise<{
  groups: { id: number; name: string; unit: ComponentUnit; componentIds: number[] }[];
  components: { id: number; name: string; type: ComponentType; unit: ComponentUnit; groupId: number | null }[];
}> {
  const { components, groups } = await loadItemModel();
  return {
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      unit: g.unit,
      componentIds: components.filter((c) => c.inventory_group_id === g.id).map((c) => c.id),
    })),
    components: components
      .map((c) => ({ id: c.id, name: c.account, type: c.type, unit: c.unit, groupId: c.inventory_group_id }))
      .sort((a, b) => COMPONENT_TYPES.indexOf(a.type) - COMPONENT_TYPES.indexOf(b.type) || a.name.localeCompare(b.name)),
  };
}

export async function getInventoryLedger(): Promise<InventoryLedger> {
  const today = egyptToday();
  const { startDate } = await getInventorySettings();
  if (!startDate) return { startDate: null, today, rows: [] };

  const [structure, model, openings] = await Promise.all([
    getProductStructure(),
    loadItemModel(),
    fetchAllRows<OpeningRow>(supabase, "inventory_opening_balances", "id, component_id, group_id, quantity"),
  ]);

  const exploder = createBomExploder(structure);
  const unitOf = new Map(model.components.map((c) => [c.id, c.unit]));
  const { refOf } = model;
  const movements = new Map<string, Map<string, InventoryMovement>>();

  function move(componentId: number, day: string): InventoryMovement {
    const ref = refOf.get(componentId);
    if (!ref) return emptyMovement(); // unknown component - discarded
    return moveByKey(itemKey(ref), day);
  }

  function moveByKey(key: string, day: string): InventoryMovement {
    let byDay = movements.get(key);
    if (!byDay) {
      byDay = new Map();
      movements.set(key, byDay);
    }
    let m = byDay.get(day);
    if (!m) {
      m = emptyMovement();
      byDay.set(day, m);
    }
    return m;
  }

  // BOM quantities are entered in the allocation unit (g / ml / pc); stock is
  // kept in the priced unit (KG / L / Pcs).
  function toPricedUnit(componentId: number, allocationQty: number): number {
    return allocationQty / UNIT_DIVISOR[unitOf.get(componentId) ?? "pcs"];
  }

  // ---- Additions: purchases ----------------------------------------------
  // The seeded baseline rows (null quantity) carry a starting cost, not stock.
  const purchases = await fetchAllRows<{ date: string; component_id: number; quantity: number | null }>(
    supabase,
    "purchases",
    "date, component_id, quantity",
    (q) => q.not("quantity", "is", null).gte("date", startDate)
  );
  for (const p of purchases) {
    const qty = Number(p.quantity ?? 0);
    if (qty <= 0) continue;
    move(p.component_id, p.date).purchases += qty;
  }

  // ---- Deductions: orders shipped, and additions: their returns -----------
  // One scan covers both, because a return is only credited when its own order
  // was shipped on/after the start date - an earlier order's stock was never
  // deducted here, so adding it back would invent inventory.
  const lineItems = await fetchAllRows<{
    product_id: number | null;
    quantity: number;
    orders: {
      cancelled_at: string | null;
      courier: string | null;
      bosta_picked_up_day: string | null;
      movers_record_date: string | null;
      outcome: string | null;
      resolved_at: string | null;
    } | null;
  }>(
    supabase,
    "order_line_items",
    "product_id, quantity, orders!inner(cancelled_at, courier, bosta_picked_up_day, movers_record_date, outcome, resolved_at)",
    (q) => q.not("orders.courier", "is", null).is("orders.cancelled_at", null)
  );

  for (const li of lineItems) {
    const order = li.orders;
    if (!order) continue;
    const shipped = shipDay(order);
    if (shipped === null || shipped < startDate) continue;
    const pid = li.product_id;
    if (pid == null) continue;
    const units = li.quantity ?? 0;
    if (units <= 0) continue;

    exploder.explode(
      pid,
      units,
      () => {},
      (componentId, allocationQty) => {
        move(componentId, shipped).orders += toPricedUnit(componentId, allocationQty);
      }
    );

    // Came back from the courier: credited on the day the return resolved.
    if (order.outcome && RETURN_OUTCOMES.has(order.outcome) && order.resolved_at) {
      const backDay = egyptDayOf(order.resolved_at);
      if (backDay) {
        exploder.explode(
          pid,
          units,
          () => {},
          (componentId, allocationQty) => {
            move(componentId, backDay).returns += toPricedUnit(componentId, allocationQty);
          }
        );
      }
    }
  }

  // ---- Adjustments: typed in by hand, per line per day --------------------
  // Signed (+ found / - lost: wastage, breakage, samples, recount corrections).
  // Already keyed by item (group or component), so no BOM explosion.
  const adjustments = await fetchAllRows<{
    date: string;
    component_id: number | null;
    group_id: number | null;
    quantity: number;
  }>(supabase, "inventory_adjustments", "id, date, component_id, group_id, quantity", (q) => q.gte("date", startDate));

  for (const a of adjustments) {
    const ref = itemRefOf(a, refOf);
    if (!ref) continue;
    moveByKey(itemKey(ref), a.date).adjustments += Number(a.quantity);
  }

  const openingBy = new Map<string, number>();
  for (const o of openings) {
    const key = openingKeyOf(o);
    if (key) openingBy.set(key, Number(o.quantity));
  }

  // ---- Assemble ----------------------------------------------------------
  const rows: InventoryItemRow[] = model.items.map((i) => ({
    ...i,
    opening: openingBy.get(i.key) ?? 0,
    days: Object.fromEntries(movements.get(i.key) ?? []),
  }));

  return { startDate, today, rows };
}
