"use client";

import { useState } from "react";
import { ReturnsForm } from "./shipping-orders/ship-form";
import { ShippingAnalysisTab } from "./shipping-analysis-tab";
import type { ShipperSummary, DeliveryRatesResult, ProductMonthlyRate } from "@/lib/shipping/shared";
import type { ShippingAnalysisRow } from "@/lib/shipping/analysis";

const TABS = [
  { key: "returns" as const, label: "Record Returns" },
  { key: "analysis" as const, label: "Analysis" },
];

type TabKey = (typeof TABS)[number]["key"];

export function ShippingTabs({
  summaries,
  analysis,
  rates,
  productRates,
  access,
}: {
  summaries: ShipperSummary[];
  analysis: ShippingAnalysisRow[];
  rates: DeliveryRatesResult;
  productRates: ProductMonthlyRate[];
  /** view/edit per inner tab, from src/lib/permissions.ts. */
  access: Record<TabKey, { view: boolean; edit: boolean }>;
}) {
  const tabs = TABS.filter((t) => access[t.key].view);
  const [tab, setTab] = useState<TabKey>(tabs[0]?.key ?? "returns");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t.key ? "border-b-2 border-gray-900 text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "returns" && (
        <div className="space-y-2">
          <p className="text-xs text-gray-400">
            Paste returned order numbers. Each one is marked returned and stays returned even if Khazenly&apos;s status in
            Shopify later says delivered. Orders with no Khazenly fulfillment in Shopify are reported and left untouched.
          </p>
          <ReturnsForm summaries={summaries} canEdit={access.returns.edit} />
        </div>
      )}

      {tab === "analysis" && <ShippingAnalysisTab rows={analysis} rates={rates} productRates={productRates} />}
    </div>
  );
}
