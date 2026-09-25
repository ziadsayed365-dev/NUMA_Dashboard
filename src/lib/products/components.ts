import "server-only";
import { supabase } from "@/lib/supabase";
import {
  COMPONENT_TYPES,
  COMPONENT_UNITS,
  type ComponentInput,
  type ComponentType,
  type ComponentUnit,
  type ProductComponent,
} from "./component-types";

// Re-export the shared constants/types so server callers can keep importing
// them from here; client components must import from ./component-types directly
// (this module is server-only).
export * from "./component-types";

type Row = {
  id: number;
  type: ComponentType;
  account: string;
  unit: ComponentUnit;
  cost: number | null;
  updated_at: string;
};

export async function getProductComponents(): Promise<ProductComponent[]> {
  const { data, error } = await supabase
    .from("product_components")
    .select("id, type, account, unit, cost, updated_at")
    .order("type", { ascending: true })
    .order("account", { ascending: true });
  if (error) throw new Error(`Failed to load product_components: ${error.message}`);

  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    type: r.type,
    account: r.account,
    unit: r.unit,
    cost: r.cost === null ? null : Number(r.cost),
    updatedAt: r.updated_at,
  }));
}

function validate(input: ComponentInput): void {
  if (!COMPONENT_TYPES.includes(input.type)) throw new Error("Invalid type");
  if (!COMPONENT_UNITS.includes(input.unit)) throw new Error("Invalid unit");
  if (!input.account || !input.account.trim()) throw new Error("Account name is required");
  if (input.cost !== null && !Number.isFinite(input.cost)) throw new Error("Cost must be a number");
  if (input.cost !== null && input.cost < 0) throw new Error("Cost cannot be negative");
}

const BASELINE_DATE = "2000-01-01";

// The margin engine prices a component from its purchase history only (see
// getComponentCostTimelines), so the cost typed here must also land there as
// the component's BASELINE purchase (effective 2000-01-01, quantity null - not
// shown in the Purchasing list). Without it a component added after migration
// 0046 seeded the baselines has no price at all, and every order using it is
// costed at 0.
//
// While the component has no real purchases, the typed cost IS its whole price
// history, so the baseline follows every edit. Once real purchases exist they
// own the history from their dates on; the baseline is only created if missing,
// never rewritten, so an edit here can't silently re-price past orders.
async function syncBaselineCost(componentId: number, cost: number | null): Promise<void> {
  if (cost === null) return;
  const { data: rows, error } = await supabase
    .from("purchases")
    .select("id, quantity, date")
    .eq("component_id", componentId);
  if (error) throw new Error(`Failed to read purchase history: ${error.message}`);
  const baseline = (rows ?? []).find((r) => r.quantity === null && r.date === BASELINE_DATE);
  const hasRealPurchases = (rows ?? []).some((r) => r.quantity !== null);

  if (!baseline) {
    const { error: insErr } = await supabase
      .from("purchases")
      .insert({ date: BASELINE_DATE, component_id: componentId, quantity: null, amount: cost });
    if (insErr) throw new Error(`Failed to set the component's starting cost: ${insErr.message}`);
  } else if (!hasRealPurchases) {
    const { error: upErr } = await supabase.from("purchases").update({ amount: cost }).eq("id", baseline.id);
    if (upErr) throw new Error(`Failed to set the component's starting cost: ${upErr.message}`);
  }
}

export async function createProductComponent(input: ComponentInput): Promise<number> {
  validate(input);
  const { data, error } = await supabase
    .from("product_components")
    .insert({ type: input.type, account: input.account.trim(), unit: input.unit, cost: input.cost })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create component: ${error?.message}`);
  await syncBaselineCost(data.id, input.cost);
  return data.id;
}

export async function updateProductComponent(id: number, input: ComponentInput): Promise<void> {
  validate(input);
  const { error } = await supabase
    .from("product_components")
    .update({
      type: input.type,
      account: input.account.trim(),
      unit: input.unit,
      cost: input.cost,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to update component: ${error.message}`);
  await syncBaselineCost(id, input.cost);
}

export async function deleteProductComponents(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from("product_components").delete().in("id", ids);
  if (error) throw new Error(`Failed to delete components: ${error.message}`);
}
