import "server-only";
import { supabase } from "@/lib/supabase";
import type { ComponentType, ComponentUnit } from "@/lib/products/component-types";

// One product component available to purchase - the dropdown in the Purchasing
// tab. currentCost is its cost per priced unit right now (used for the 20%
// increase check before saving).
export type PurchaseComponentOption = {
  id: number;
  name: string;
  type: ComponentType;
  unit: ComponentUnit;
  currentCost: number | null;
};

// A recorded purchase (Purchasing tab list). amount is the cost per unit paid;
// quantity is how many units were bought.
export type PurchaseRecord = {
  id: number;
  date: string;
  componentId: number;
  componentName: string;
  unit: ComponentUnit;
  quantity: number | null;
  amount: number;
  description: string | null;
};

// Every component (raw material, package, other) - the purchase dropdown.
export async function getPurchaseComponents(): Promise<PurchaseComponentOption[]> {
  const { data, error } = await supabase.from("product_components").select("id, account, type, unit, cost");
  if (error) throw new Error(`Failed to load components: ${error.message}`);
  return (data ?? [])
    .map((c) => ({
      id: c.id as number,
      name: c.account as string,
      type: c.type as ComponentType,
      unit: c.unit as ComponentUnit,
      currentCost: c.cost === null ? null : Number(c.cost),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type PurchaseRow = {
  id: number;
  date: string;
  component_id: number;
  quantity: number | null;
  amount: number;
  description: string | null;
  product_components: { account: string; unit: ComponentUnit } | null;
};

// Recorded purchases, newest first. Excludes the seeded baseline rows (which
// carry each component's starting cost and have a null quantity).
export async function getPurchases(): Promise<PurchaseRecord[]> {
  const { data, error } = await supabase
    .from("purchases")
    .select("id, date, component_id, quantity, amount, description, product_components(account, unit)")
    .not("quantity", "is", null)
    .order("date", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error(`Failed to load purchases: ${error.message}`);

  return ((data ?? []) as unknown as PurchaseRow[]).map((r) => ({
    id: r.id,
    date: r.date,
    componentId: r.component_id,
    componentName: r.product_components?.account ?? "",
    unit: r.product_components?.unit ?? "pcs",
    quantity: r.quantity === null ? null : Number(r.quantity),
    amount: Number(r.amount),
    description: r.description ?? null,
  }));
}

// Record a purchase and update the component's current cost to the newest-dated
// purchase (so the Product Components tab and current-cost projections reflect
// the latest price). The dated purchase history is what the margin engine uses
// to cost each order at the price in effect on its own date.
export async function createPurchase(input: {
  componentId: number;
  date: string;
  quantity: number;
  amount: number;
  description?: string | null;
}): Promise<number> {
  if (!Number.isFinite(input.componentId)) throw new Error("Pick a component");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Invalid date");
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error("Quantity must be positive");
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error("Amount must be zero or a positive number");

  const description = input.description?.trim() ? input.description.trim() : null;

  const { data, error } = await supabase
    .from("purchases")
    .insert({ date: input.date, component_id: input.componentId, quantity: input.quantity, amount: input.amount, description })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to save purchase: ${error?.message}`);

  // Current cost = the amount of the newest-dated purchase for this component.
  const { data: latest, error: latestErr } = await supabase
    .from("purchases")
    .select("amount")
    .eq("component_id", input.componentId)
    .order("date", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) throw new Error(`Failed to read latest cost: ${latestErr.message}`);
  if (latest) {
    const { error: upErr } = await supabase
      .from("product_components")
      .update({ cost: Number(latest.amount), updated_at: new Date().toISOString() })
      .eq("id", input.componentId);
    if (upErr) throw new Error(`Failed to update component cost: ${upErr.message}`);
  }

  return data.id;
}

export async function deletePurchase(id: number): Promise<void> {
  // Find the component so we can recompute its current cost after removal.
  const { data: row, error: rowErr } = await supabase.from("purchases").select("component_id").eq("id", id).maybeSingle();
  if (rowErr) throw new Error(`Failed to load purchase: ${rowErr.message}`);
  const { error } = await supabase.from("purchases").delete().eq("id", id);
  if (error) throw new Error(`Failed to remove purchase: ${error.message}`);

  if (row) {
    const { data: latest } = await supabase
      .from("purchases")
      .select("amount")
      .eq("component_id", row.component_id)
      .order("date", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest) {
      await supabase
        .from("product_components")
        .update({ cost: Number(latest.amount), updated_at: new Date().toISOString() })
        .eq("id", row.component_id);
    }
  }
}
