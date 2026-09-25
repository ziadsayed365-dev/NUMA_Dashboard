import "server-only";
import type { ProductStructure, FinalProduct } from "./final-products";

// Turning one sold line into "which single products, and which components, and
// how much of each" is needed by two surfaces that must never disagree: the
// Purchasing Report (quantity used) and Inventory (quantity deducted from
// stock). This is that decomposition, in one place.
//
// Deliberately VARIANT-BLIND: stock is counted per whole product, not per
// variant. A sold item consumes its product's bill of materials whichever
// variant it was, so the Inventory ledger reads as "we shipped 12 oils" rather
// than splitting the same shipment across seven scents. Per-variant costing
// still happens in the margin engine (getBuiltCostResolver) - that's a separate
// question from what physically left the shelf.
//
// Component quantities come out in the ALLOCATION unit the BOM is entered in
// (g / ml / pc). Callers that want the priced unit (KG / L / Pcs) divide by
// UNIT_DIVISOR - the Report shows allocation units, Inventory converts.

export type ProductSink = (singleId: number, name: string, units: number) => void;
export type ComponentSink = (componentId: number, allocationQty: number) => void;

export type BomExploder = {
  // Bundles are decomposed into their member single products (a bundle is never
  // reported as a product itself); a product not modeled in the BOM still
  // reports its units, with no components.
  explode: (productId: number, units: number, onProduct: ProductSink, onComponent: ComponentSink) => void;
};

export function createBomExploder({ singles, bundles }: ProductStructure): BomExploder {
  const singleById = new Map(singles.map((s) => [s.id, s]));
  const bundleById = new Map(bundles.map((b) => [b.id, b]));

  // Some products keep their real raw material on the VARIANT rather than the
  // product - each essential oil scent, for instance, sits in that variant's
  // own lines while the product only carries the shared bottle and label.
  // Ignoring those lines outright would mean no oil ever leaves stock, so the
  // product is treated as one averaged item: the total across its costed
  // variants, divided by how many there are. The quantity consumed is therefore
  // right for the product as a whole, which is exactly what this ledger counts.
  const averagedExtras = new Map<number, { componentId: number; quantity: number }[]>();
  for (const s of singles) {
    const costed = s.variants.filter((v) => v.mappings.length > 0);
    if (costed.length === 0) continue;
    const totals = new Map<number, number>();
    for (const v of costed) {
      for (const m of v.mappings) totals.set(m.componentId, (totals.get(m.componentId) ?? 0) + m.quantity);
    }
    averagedExtras.set(
      s.id,
      [...totals].map(([componentId, quantity]) => ({ componentId, quantity: quantity / costed.length }))
    );
  }

  function addSingle(single: FinalProduct, units: number, onComponent: ComponentSink) {
    for (const m of single.mappings) onComponent(m.componentId, m.quantity * units);
    const extras = averagedExtras.get(single.id);
    if (extras) for (const m of extras) onComponent(m.componentId, m.quantity * units);
  }

  function explode(productId: number, units: number, onProduct: ProductSink, onComponent: ComponentSink): void {
    const single = singleById.get(productId);
    if (single) {
      onProduct(single.id, single.name, units);
      addSingle(single, units, onComponent);
      return;
    }

    const bundle = bundleById.get(productId);
    if (bundle) {
      for (const item of bundle.items) {
        if (item.kind === "product") {
          const member = singleById.get(item.refId);
          if (!member) continue;
          const memberUnits = item.quantity * units;
          onProduct(member.id, member.name, memberUnits);
          addSingle(member, memberUnits, onComponent);
        } else {
          // A bundle-level component (e.g. the bundle box).
          onComponent(item.refId, item.quantity * units);
        }
      }
      return;
    }

    // Product not modeled in the BOM at all - still count the units.
    onProduct(productId, `#${productId}`, units);
  }

  return { explode };
}
