import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday } from "@/lib/dates";

// Sentinel "since the beginning of time" date, used to backdate a model's
// first-ever real cost so it applies to every order already placed for it -
// matching the all-time-start convention used elsewhere (e.g. /products).
const ALL_TIME_START = "2000-01-01";

export type CatalogProduct = {
  id: number;
  name: string;
  sku: string | null;
  currentPrice: number | null;
  modelGroupId: number | null;
  modelGroupName: string | null;
  unitCost: number | null;
  isActive: boolean;
};

export type ModelGroupOption = { id: number; name: string; unitCost: number | null };

export async function getProductCatalog(): Promise<{ products: CatalogProduct[]; modelGroups: ModelGroupOption[] }> {
  const modelGroupRows = await fetchAllRows<{ id: number; name: string; unit_cost: number | null }>(
    supabase,
    "model_groups",
    "id, name, unit_cost"
  );
  const modelGroups = modelGroupRows
    .map((m) => ({ id: m.id, name: m.name, unitCost: m.unit_cost }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const modelGroupById = new Map(modelGroups.map((m) => [m.id, m]));

  const productRows = await fetchAllRows<{
    id: number;
    name: string;
    sku: string | null;
    current_price: number | null;
    model_group_id: number | null;
    status: string | null;
  }>(supabase, "products", "id, name, sku, current_price, model_group_id, status");

  const products = productRows
    .map((p) => {
      const group = p.model_group_id ? modelGroupById.get(p.model_group_id) : null;
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        currentPrice: p.current_price,
        modelGroupId: p.model_group_id,
        modelGroupName: group?.name ?? null,
        unitCost: group?.unitCost ?? null,
        // Products seeded before the status sync existed have status = null;
        // treat unknown as active so they don't vanish from the default view.
        isActive: p.status !== "ARCHIVED" && p.status !== "DRAFT",
      };
    })
    // Group by model so colors of the same shoe sit together; ungrouped products sort last.
    .sort((a, b) => {
      if (a.modelGroupName === null && b.modelGroupName !== null) return 1;
      if (a.modelGroupName !== null && b.modelGroupName === null) return -1;
      if (a.modelGroupName !== b.modelGroupName) return (a.modelGroupName ?? "").localeCompare(b.modelGroupName ?? "");
      return a.name.localeCompare(b.name);
    });

  return { products, modelGroups };
}

export async function listModelGroups(): Promise<ModelGroupOption[]> {
  const rows = await fetchAllRows<{ id: number; name: string; unit_cost: number | null }>(supabase, "model_groups", "id, name, unit_cost");
  return rows.map((m) => ({ id: m.id, name: m.name, unitCost: m.unit_cost })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function createModelGroup(input: { name: string; unitCost: number | null }): Promise<number> {
  if (!input.name.trim()) throw new Error("Model group name is required");

  const { data, error } = await supabase
    .from("model_groups")
    .insert({ name: input.name.trim(), unit_cost: input.unitCost })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create model group: ${error?.message}`);

  if (input.unitCost !== null) {
    // Brand new model - apply its first cost to any orders that already
    // exist for it (e.g. ordered before this model was set up), same rule
    // as a first-time cost entry on an existing model below.
    const { error: historyErr } = await supabase
      .from("model_group_cost_history")
      .insert({ model_group_id: data.id, unit_cost: input.unitCost, effective_from: ALL_TIME_START });
    if (historyErr) throw new Error(`Failed to record cost history: ${historyErr.message}`);
  }

  return data.id;
}

export async function updateModelGroupCost(id: number, unitCost: number | null): Promise<void> {
  if (unitCost !== null) {
    const { data: group, error: groupErr } = await supabase.from("model_groups").select("unit_cost").eq("id", id).single();
    if (groupErr || !group) throw new Error(`Failed to load model group: ${groupErr?.message}`);

    const { count, error: countErr } = await supabase
      .from("model_group_cost_history")
      .select("id", { count: "exact", head: true })
      .eq("model_group_id", id);
    if (countErr) throw new Error(`Failed to check cost history: ${countErr.message}`);

    const rows: Array<{ model_group_id: number; unit_cost: number; effective_from: string }> = [];
    if ((count ?? 0) === 0 && group.unit_cost !== null) {
      // Already had a real cost before this history table existed -
      // preserve it for past orders, and only apply the new value from
      // today forward (a genuine cost change, not a first-time entry).
      rows.push({ model_group_id: id, unit_cost: group.unit_cost, effective_from: ALL_TIME_START });
      rows.push({ model_group_id: id, unit_cost: unitCost, effective_from: egyptToday() });
    } else if ((count ?? 0) === 0) {
      // First real cost ever set for this model - every past order for it
      // was silently treated as zero cost until now, so backdate it.
      rows.push({ model_group_id: id, unit_cost: unitCost, effective_from: ALL_TIME_START });
    } else {
      // Already has a cost history - this is a real change (e.g. a
      // supplier price increase), so it should only affect orders from
      // today forward, not rewrite already-reported historical margins.
      rows.push({ model_group_id: id, unit_cost: unitCost, effective_from: egyptToday() });
    }

    const { error: historyErr } = await supabase.from("model_group_cost_history").insert(rows);
    if (historyErr) throw new Error(`Failed to record cost history: ${historyErr.message}`);
  }

  const { error } = await supabase
    .from("model_groups")
    .update({ unit_cost: unitCost, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Failed to update model group cost: ${error.message}`);
}

export async function assignProductModelGroup(productId: number, modelGroupId: number | null): Promise<void> {
  const { error } = await supabase
    .from("products")
    .update({ model_group_id: modelGroupId, updated_at: new Date().toISOString() })
    .eq("id", productId);
  if (error) throw new Error(`Failed to assign model group: ${error.message}`);
}
