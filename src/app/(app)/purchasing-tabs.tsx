"use client";

import { useState } from "react";
import type { PurchaseComponentOption, PurchaseRecord } from "@/lib/purchases/purchases";
import type { InventoryItem } from "@/lib/inventory/inventory";
import { PurchasingTab } from "./purchasing-tab";
import { PurchasingReport } from "./purchasing-report";
import { InventoryTab } from "./inventory-tab";

const TABS = [
  { key: "recording" as const, label: "Recording" },
  { key: "report" as const, label: "Report" },
  { key: "inventory" as const, label: "Inventory" },
];

type TabKey = (typeof TABS)[number]["key"];

export function PurchasingTabs({
  components,
  initialPurchases,
  openingRows,
  access,
}: {
  components: PurchaseComponentOption[];
  initialPurchases: PurchaseRecord[];
  openingRows: InventoryItem[];
  /** view/edit per inner tab, from src/lib/permissions.ts. */
  access: Record<TabKey, { view: boolean; edit: boolean }>;
}) {
  const tabs = TABS.filter((t) => access[t.key].view);
  const [active, setActive] = useState<TabKey>(tabs[0]?.key ?? "recording");

  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={
              active === t.key
                ? "border-b-2 border-gray-900 px-3 py-2 text-sm font-medium text-gray-900"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === "recording" && <PurchasingTab components={components} initialPurchases={initialPurchases} />}
      {active === "report" && <PurchasingReport />}
      {active === "inventory" && <InventoryTab openingRows={openingRows} canEdit={access.inventory.edit} />}
    </div>
  );
}
