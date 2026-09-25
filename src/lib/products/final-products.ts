import "server-only";
import { cache } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { computeLineCost, type ComponentType, type ComponentUnit } from "./component-types";

// ---- Single (final) products: mapped to raw material / package / other ----
export type ProductMapping = {
  componentId: number;
  type: ComponentType;
  account: string;
  unit: ComponentUnit;
  costPerUnit: number | null;
  quantity: number;
  lineCost: number | null;
};

// One variant's build: the components that differ for this variant (typically
// just its raw material), on top of the product's shared base. builtCost is the
// full per-unit cost = product base + this variant's extra lines.
export type VariantBuild = {
  variantId: number;
  title: string | null;
  sku: string | null;
  mappings: ProductMapping[];
  extraCost: number;
  builtCost: number;
  hasMissingCost: boolean;
};

export type FinalProduct = {
  id: number;
  name: string;
  sku: string | null;
  currentPrice: number | null;
  isActive: boolean;
  mappings: ProductMapping[];
  totalCost: number;
  hasMissingCost: boolean;
  // Present only for products with more than one Shopify variant; each variant's
  // cost builds on top of this product's shared `mappings`/`totalCost`.
  variants: VariantBuild[];
};

// ---- Bundles: built from member (single) products + Other components ----
export type BundleItem = {
  kind: "product" | "component";
  refId: number; // member product id, or component id
  label: string;
  quantity: number;
  perUnitCost: number | null; // product: its built cost; component: cost per priced unit
  unit: ComponentUnit | null; // component allocation unit; null for a product member (counted as pieces)
  lineCost: number | null;
};

export type BundleProduct = {
  id: number;
  name: string;
  currentPrice: number | null;
  isActive: boolean;
  items: BundleItem[];
  totalCost: number;
  hasMissingCost: boolean;
};

export type MemberOption = { id: number; name: string; builtCost: number; isActive: boolean };
export type OtherComponentOption = { id: number; account: string; unit: ComponentUnit; cost: number | null };

export type ProductStructure = {
  singles: FinalProduct[];
  bundles: BundleProduct[];
  memberOptions: MemberOption[]; // single products, for a bundle's dropdown
  otherComponents: OtherComponentOption[]; // Other-type components, for a bundle's dropdown
};

function isActive(status: string | null): boolean {
  return status !== "ARCHIVED" && status !== "DRAFT";
}

// Bundle members and Other components share one dropdown; a product member is
// counted in whole pieces (no unit conversion), a component uses its unit.
function bundleLineCost(item: { kind: "product" | "component"; perUnitCost: number | null; unit: ComponentUnit | null; quantity: number }): number | null {
  if (item.perUnitCost === null) return null;
  if (item.kind === "product") return item.perUnitCost * item.quantity;
  return computeLineCost(item.perUnitCost, item.unit ?? "pcs", item.quantity);
}

// Built cost per product for the reports' open-month COGS projection: single =
// its component build, bundle = its contents roll-up. Only products that
// actually have a BOM entered are included; the rest are absent (treated as
// "cost missing"). A multi-variant product is projected at the AVERAGE of its
// variants' built costs, since the projection doesn't know the future variant
// mix (the real per-order engine below uses the exact variant).
export const getBuiltCostByProduct = cache(async (): Promise<Map<number, number>> => {
  const { singles, bundles } = await getProductStructure();
  const map = new Map<number, number>();
  for (const s of singles) {
    if (s.variants.length > 0) {
      if (s.mappings.length > 0 || s.variants.some((v) => v.mappings.length > 0)) {
        const avg = s.variants.reduce((sum, v) => sum + v.builtCost, 0) / s.variants.length;
        map.set(s.id, avg);
      }
    } else if (s.mappings.length > 0) {
      map.set(s.id, s.totalCost);
    }
  }
  for (const b of bundles) if (b.items.length > 0) map.set(b.id, b.totalCost);
  return map;
});

// Per-variant built cost (product shared base + the variant's own lines) at
// current component costs, for the Product List display. null when nothing is
// costed for the variant yet. Date-aware costing for real orders lives in
// getBuiltCostResolver.
export const getVariantBuiltCosts = cache(async (): Promise<Map<number, number | null>> => {
  const { singles } = await getProductStructure();
  const map = new Map<number, number | null>();
  for (const s of singles) {
    for (const v of s.variants) {
      const hasAny = s.mappings.length > 0 || v.mappings.length > 0;
      map.set(v.variantId, hasAny ? v.builtCost : null);
    }
  }
  return map;
});

// Every component's cost timeline from the Purchasing tab (the seeded baseline
// plus each purchase), sorted ascending by date. The margin engine uses this to
// cost an order by the component prices in effect on the order's own date.
export const getComponentCostTimelines = cache(async (): Promise<Map<number, { date: string; cost: number }[]>> => {
  const rows = await fetchAllRows<{ component_id: number; date: string; amount: number }>(
    supabase,
    "purchases",
    "id, component_id, date, amount"
  );
  const byComponent = new Map<number, { date: string; cost: number }[]>();
  for (const r of rows) {
    const list = byComponent.get(r.component_id) ?? [];
    list.push({ date: r.date, cost: Number(r.amount) });
    byComponent.set(r.component_id, list);
  }
  for (const list of byComponent.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return byComponent;
});

// The component's cost in effect on `date` = the newest timeline entry on or
// before it (null if the component never had a cost).
function componentCostAt(timeline: { date: string; cost: number }[] | undefined, date: string): number | null {
  if (!timeline || timeline.length === 0) return null;
  let cost: number | null = null;
  for (const e of timeline) {
    if (e.date <= date) cost = e.cost;
    else break;
  }
  return cost;
}

// Date-aware built cost: `at(productId, variantId, date)` returns the per-unit
// built cost using each component's price in effect on that date (null if
// nothing is costed - i.e. cost missing). The variant's own lines are added on
// top of the product's shared base: when the sold variant is known (Shopify
// orders) its exact extra is used; when it isn't (projections) the
// average across the product's variants is used, so a variant-costed product is
// never undercounted to just its shared base. Used by the margin engine so a
// June order costs at June prices and a July order at July prices.
export const getBuiltCostResolver = cache(
  async (): Promise<{ at: (productId: number, variantId: number | null, date: string) => number | null }> => {
    const { singles, bundles } = await getProductStructure();
    const timelines = await getComponentCostTimelines();
    const singleById = new Map(singles.map((s) => [s.id, s]));
    const bundleById = new Map(bundles.map((b) => [b.id, b]));
    const variantById = new Map<number, VariantBuild>();
    for (const s of singles) for (const v of s.variants) variantById.set(v.variantId, v);
    const memo = new Map<string, number | null>();

    const sumMappings = (mappings: ProductMapping[], date: string): number =>
      mappings.reduce(
        (sum, m) => sum + (computeLineCost(componentCostAt(timelines.get(m.componentId), date), m.unit, m.quantity) ?? 0),
        0
      );
    const variantExtraAt = (variant: VariantBuild | undefined, date: string): number | null =>
      variant && variant.mappings.length > 0 ? sumMappings(variant.mappings, date) : null;

    function at(productId: number, variantId: number | null, date: string, seen: Set<number> = new Set()): number | null {
      const key = `${productId}|${variantId ?? "-"}|${date}`;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      if (seen.has(productId)) return null; // guard against a bundle cycle
      seen.add(productId);

      let result: number | null = null;
      const single = singleById.get(productId);
      if (single) {
        const base = single.mappings.length > 0 ? sumMappings(single.mappings, date) : null;

        let extra = variantId != null ? variantExtraAt(variantById.get(variantId), date) : null;
        if (extra === null && single.variants.length > 0) {
          const extras = single.variants
            .map((v) => variantExtraAt(v, date))
            .filter((e): e is number => e !== null);
          if (extras.length > 0) extra = extras.reduce((s, e) => s + e, 0) / extras.length;
        }

        if (base !== null || extra !== null) result = (base ?? 0) + (extra ?? 0);
      } else {
        const bundle = bundleById.get(productId);
        if (bundle && bundle.items.length > 0) {
          result = bundle.items.reduce((sum, it) => {
            if (it.kind === "product") return sum + (at(it.refId, null, date, seen) ?? 0) * it.quantity;
            return sum + (computeLineCost(componentCostAt(timelines.get(it.refId), date), it.unit ?? "pcs", it.quantity) ?? 0);
          }, 0);
        }
      }

      memo.set(key, result);
      return result;
    }

    return { at: (productId, variantId, date) => at(productId, variantId, date) };
  }
);

export async function getProductStructure(): Promise<ProductStructure> {
  // These four reads are independent, so run them concurrently rather than as a
  // chain of round-trips (this function is on the report + margin + product paths).
  const [productRows, componentRows, fpcRows, bundleItemRows, variantRows, variantComponentRows] = await Promise.all([
    fetchAllRows<{
      id: number;
      name: string;
      sku: string | null;
      current_price: number | null;
      status: string | null;
      is_bundle: boolean;
    }>(supabase, "products", "id, name, sku, current_price, status, is_bundle"),
    fetchAllRows<{
      id: number;
      type: ComponentType;
      account: string;
      unit: ComponentUnit;
      cost: number | null;
    }>(supabase, "product_components", "id, type, account, unit, cost"),
    fetchAllRows<{ product_id: number; component_id: number; quantity: number }>(
      supabase,
      "final_product_components",
      "product_id, component_id, quantity"
    ),
    fetchAllRows<{
      bundle_product_id: number;
      member_product_id: number | null;
      component_id: number | null;
      quantity: number;
    }>(supabase, "bundle_items", "bundle_product_id, member_product_id, component_id, quantity"),
    fetchAllRows<{ id: number; product_id: number; title: string | null; sku: string | null; position: number | null }>(
      supabase,
      "product_variants",
      "id, product_id, title, sku, position"
    ),
    fetchAllRows<{ variant_id: number; component_id: number; quantity: number }>(
      supabase,
      "variant_components",
      "variant_id, component_id, quantity"
    ),
  ]);
  const componentById = new Map(componentRows.map((c) => [c.id, c]));

  // Variant-specific component mappings, grouped by variant (same shape as the
  // product mappings below, just keyed on the variant).
  const mappingsByVariant = new Map<number, ProductMapping[]>();
  for (const m of variantComponentRows) {
    const component = componentById.get(m.component_id);
    if (!component) continue;
    const quantity = Number(m.quantity);
    const costPerUnit = component.cost === null ? null : Number(component.cost);
    const list = mappingsByVariant.get(m.variant_id) ?? [];
    list.push({
      componentId: component.id,
      type: component.type,
      account: component.account,
      unit: component.unit,
      costPerUnit,
      quantity,
      lineCost: computeLineCost(costPerUnit, component.unit, quantity),
    });
    mappingsByVariant.set(m.variant_id, list);
  }

  // Variants grouped by product, position-ordered. Only products with more than
  // one variant get a per-variant build in the UI; a lone "Default Title"
  // variant adds nothing over the product-level build.
  const variantsByProduct = new Map<number, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  // Single-product component mappings, grouped by product.
  const mappingsByProduct = new Map<number, ProductMapping[]>();
  for (const m of fpcRows) {
    const component = componentById.get(m.component_id);
    if (!component) continue;
    const quantity = Number(m.quantity);
    const costPerUnit = component.cost === null ? null : Number(component.cost);
    const list = mappingsByProduct.get(m.product_id) ?? [];
    list.push({
      componentId: component.id,
      type: component.type,
      account: component.account,
      unit: component.unit,
      costPerUnit,
      quantity,
      lineCost: computeLineCost(costPerUnit, component.unit, quantity),
    });
    mappingsByProduct.set(m.product_id, list);
  }

  const singles: FinalProduct[] = [];
  const builtCostByProduct = new Map<number, number>();
  for (const p of productRows) {
    if (p.is_bundle) continue;
    const mappings = (mappingsByProduct.get(p.id) ?? []).sort(
      (a, b) => a.type.localeCompare(b.type) || a.account.localeCompare(b.account)
    );
    const totalCost = mappings.reduce((sum, m) => sum + (m.lineCost ?? 0), 0);

    // Per-variant builds sit on top of the shared product base. Skip
    // single-variant products - their build is fully captured at product level.
    const productVariants = (variantsByProduct.get(p.id) ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.title ?? "").localeCompare(b.title ?? ""));
    const variants: VariantBuild[] =
      productVariants.length > 1
        ? productVariants.map((v) => {
            const vMappings = (mappingsByVariant.get(v.id) ?? []).sort(
              (a, b) => a.type.localeCompare(b.type) || a.account.localeCompare(b.account)
            );
            const extraCost = vMappings.reduce((sum, m) => sum + (m.lineCost ?? 0), 0);
            return {
              variantId: v.id,
              title: v.title,
              sku: v.sku,
              mappings: vMappings,
              extraCost,
              builtCost: totalCost + extraCost,
              hasMissingCost: mappings.some((m) => m.costPerUnit === null) || vMappings.some((m) => m.costPerUnit === null),
            };
          })
        : [];

    // Cost used when this product is a bundle member (and in the member
    // dropdown): a multi-variant product's real per-unit cost is the average of
    // its variants' built costs - which include the variant raw material - not
    // just the shared base. Single-variant products fall back to the base.
    const rollupCost =
      variants.length > 0 ? variants.reduce((sum, v) => sum + v.builtCost, 0) / variants.length : totalCost;
    builtCostByProduct.set(p.id, rollupCost);

    singles.push({
      id: p.id,
      name: p.name,
      sku: p.sku,
      currentPrice: p.current_price,
      isActive: isActive(p.status),
      mappings,
      totalCost,
      hasMissingCost: mappings.some((m) => m.costPerUnit === null),
      variants,
    });
  }
  singles.sort((a, b) => a.name.localeCompare(b.name));

  // Bundle contents, grouped by bundle.
  const itemsByBundle = new Map<number, BundleItem[]>();
  for (const r of bundleItemRows) {
    const quantity = Number(r.quantity);
    let item: BundleItem | null = null;
    if (r.member_product_id != null) {
      const perUnitCost = builtCostByProduct.get(r.member_product_id) ?? null;
      const member = productRows.find((p) => p.id === r.member_product_id);
      item = {
        kind: "product",
        refId: r.member_product_id,
        label: member?.name ?? `#${r.member_product_id}`,
        quantity,
        perUnitCost,
        unit: null,
        lineCost: null,
      };
    } else if (r.component_id != null) {
      const c = componentById.get(r.component_id);
      if (!c) continue;
      item = {
        kind: "component",
        refId: r.component_id,
        label: c.account,
        quantity,
        perUnitCost: c.cost === null ? null : Number(c.cost),
        unit: c.unit,
        lineCost: null,
      };
    }
    if (!item) continue;
    item.lineCost = bundleLineCost(item);
    const list = itemsByBundle.get(r.bundle_product_id) ?? [];
    list.push(item);
    itemsByBundle.set(r.bundle_product_id, list);
  }

  const bundles: BundleProduct[] = productRows
    .filter((p) => p.is_bundle)
    .map((p) => {
      const items = (itemsByBundle.get(p.id) ?? []).sort((a, b) => a.label.localeCompare(b.label));
      const totalCost = items.reduce((sum, it) => sum + (it.lineCost ?? 0), 0);
      return {
        id: p.id,
        name: p.name,
        currentPrice: p.current_price,
        isActive: isActive(p.status),
        items,
        totalCost,
        hasMissingCost: items.some((it) => it.perUnitCost === null),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const memberOptions: MemberOption[] = singles.map((s) => ({
    id: s.id,
    name: s.name,
    builtCost: builtCostByProduct.get(s.id) ?? s.totalCost,
    isActive: s.isActive,
  }));
  const otherComponents: OtherComponentOption[] = componentRows
    .filter((c) => c.type === "other")
    .map((c) => ({ id: c.id, account: c.account, unit: c.unit, cost: c.cost === null ? null : Number(c.cost) }))
    .sort((a, b) => a.account.localeCompare(b.account));

  return { singles, bundles, memberOptions, otherComponents };
}

// ---- Single-product component mapping mutations ----
export async function upsertProductComponentMapping(productId: number, componentId: number, quantity: number): Promise<void> {
  if (!Number.isFinite(productId) || !Number.isFinite(componentId)) throw new Error("Invalid product or component");
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Quantity must be zero or a positive number");
  const { error } = await supabase
    .from("final_product_components")
    .upsert(
      { product_id: productId, component_id: componentId, quantity, updated_at: new Date().toISOString() },
      { onConflict: "product_id,component_id" }
    );
  if (error) throw new Error(`Failed to save mapping: ${error.message}`);
}

export async function deleteProductComponentMapping(productId: number, componentId: number): Promise<void> {
  const { error } = await supabase
    .from("final_product_components")
    .delete()
    .eq("product_id", productId)
    .eq("component_id", componentId);
  if (error) throw new Error(`Failed to remove mapping: ${error.message}`);
}

// ---- Per-variant component mapping (the ingredient that differs by variant) ----
export async function upsertVariantComponentMapping(variantId: number, componentId: number, quantity: number): Promise<void> {
  if (!Number.isFinite(variantId) || !Number.isFinite(componentId)) throw new Error("Invalid variant or component");
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Quantity must be zero or a positive number");
  const { error } = await supabase
    .from("variant_components")
    .upsert(
      { variant_id: variantId, component_id: componentId, quantity, updated_at: new Date().toISOString() },
      { onConflict: "variant_id,component_id" }
    );
  if (error) throw new Error(`Failed to save variant mapping: ${error.message}`);
}

export async function deleteVariantComponentMapping(variantId: number, componentId: number): Promise<void> {
  const { error } = await supabase
    .from("variant_components")
    .delete()
    .eq("variant_id", variantId)
    .eq("component_id", componentId);
  if (error) throw new Error(`Failed to remove variant mapping: ${error.message}`);
}

// ---- Bundle classification + contents mutations ----
export async function setProductIsBundle(productId: number, isBundle: boolean): Promise<void> {
  const { error } = await supabase
    .from("products")
    .update({ is_bundle: isBundle, updated_at: new Date().toISOString() })
    .eq("id", productId);
  if (error) throw new Error(`Failed to update product kind: ${error.message}`);
}

type BundleItemRef = { memberProductId?: number | null; componentId?: number | null };

export async function upsertBundleItem(bundleId: number, ref: BundleItemRef, quantity: number): Promise<void> {
  const hasMember = ref.memberProductId != null;
  const hasComponent = ref.componentId != null;
  if (hasMember === hasComponent) throw new Error("Pick exactly one of a product or a component");
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Quantity must be zero or a positive number");
  if (hasMember && ref.memberProductId === bundleId) throw new Error("A bundle cannot contain itself");

  const row = {
    bundle_product_id: bundleId,
    member_product_id: hasMember ? ref.memberProductId : null,
    component_id: hasComponent ? ref.componentId : null,
    quantity,
    updated_at: new Date().toISOString(),
  };
  const onConflict = hasMember ? "bundle_product_id,member_product_id" : "bundle_product_id,component_id";
  const { error } = await supabase.from("bundle_items").upsert(row, { onConflict });
  if (error) throw new Error(`Failed to save bundle item: ${error.message}`);
}

export async function deleteBundleItem(bundleId: number, ref: BundleItemRef): Promise<void> {
  let query = supabase.from("bundle_items").delete().eq("bundle_product_id", bundleId);
  if (ref.memberProductId != null) query = query.eq("member_product_id", ref.memberProductId);
  else if (ref.componentId != null) query = query.eq("component_id", ref.componentId);
  else throw new Error("Missing reference");
  const { error } = await query;
  if (error) throw new Error(`Failed to remove bundle item: ${error.message}`);
}
