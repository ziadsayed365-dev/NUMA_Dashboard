import { requirePageView } from "@/lib/access";
import { canEdit, canView } from "@/lib/permissions";
import { NoAccess } from "../no-access";
import { getProductComponents } from "@/lib/products/components";
import { getProductStructure, getVariantBuiltCosts } from "@/lib/products/final-products";
import { getProductVariants } from "@/lib/products/variants";
import { ProductListTabs } from "../product-list-tabs";

export const dynamic = "force-dynamic";

export default async function ProductList() {
  const viewer = await requirePageView("product-list");
  if (!viewer) return <NoAccess />;

  const [components, structure, rawVariants, variantBuiltCosts] = await Promise.all([
    getProductComponents(),
    getProductStructure(),
    getProductVariants(),
    getVariantBuiltCosts(),
  ]);

  // The Product List shows each variant's built cost from its BOM (product shared
  // base + the variant's own lines), not the (BOM-owned, still null) unit_cost
  // column - so surface the built cost as the variant's cost for display.
  const variants = rawVariants.map((v) => ({ ...v, unitCost: variantBuiltCosts.get(v.id) ?? null }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Product List</h1>
      </div>
      <ProductListTabs
        components={components}
        structure={structure}
        variants={variants}
        access={{
          components: { view: canView(viewer, "product-list:components"), edit: canEdit(viewer, "product-list:components") },
          final: { view: canView(viewer, "product-list:final"), edit: canEdit(viewer, "product-list:final") },
          products: { view: canView(viewer, "product-list:products"), edit: canEdit(viewer, "product-list:products") },
        }}
      />
    </div>
  );
}
