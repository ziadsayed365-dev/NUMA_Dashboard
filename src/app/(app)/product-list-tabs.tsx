"use client";

import { useState } from "react";
import type { ProductComponent } from "@/lib/products/component-types";
import type { ProductStructure } from "@/lib/products/final-products";
import type { ProductVariant } from "@/lib/products/variants";
import { ProductComponentsTab } from "./product-components-tab";
import { FinalProductTab } from "./final-product-tab";
import { ProductOverviewTab } from "./product-overview-tab";

const TABS = [
  { key: "components" as const, label: "Product Components" },
  { key: "final" as const, label: "Final Product" },
  { key: "products" as const, label: "Product List" },
];

type TabKey = (typeof TABS)[number]["key"];

export function ProductListTabs({
  components,
  structure,
  variants,
  access,
}: {
  components: ProductComponent[];
  structure: ProductStructure;
  variants: ProductVariant[];
  /** view/edit per inner tab, from src/lib/permissions.ts. */
  access: Record<TabKey, { view: boolean; edit: boolean }>;
}) {
  const tabs = TABS.filter((t) => access[t.key].view);
  const [active, setActive] = useState<TabKey>(tabs[0]?.key ?? "components");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            className={`px-4 py-2 text-sm font-medium ${
              active === tab.key ? "border-b-2 border-gray-900 text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === "components" && <ProductComponentsTab initialComponents={components} />}
      {active === "final" && <FinalProductTab structure={structure} components={components} />}
      {active === "products" && <ProductOverviewTab structure={structure} variants={variants} />}
    </div>
  );
}
