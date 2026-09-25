import { redirect } from "next/navigation";
import { requirePageView } from "@/lib/access";
import { canEdit, canView } from "@/lib/permissions";
import { NoAccess } from "../no-access";
import { getPurchaseComponents, getPurchases } from "@/lib/purchases/purchases";
import { getOpeningBalances } from "@/lib/inventory/inventory";
import { PurchasingTabs } from "../purchasing-tabs";

export const dynamic = "force-dynamic";

export default async function PurchasingPage() {
  const viewer = await requirePageView("purchasing");
  if (!viewer) return <NoAccess />;

  const [components, purchases, opening] = await Promise.all([
    getPurchaseComponents(),
    getPurchases(),
    getOpeningBalances(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Purchasing</h1>
        <p className="text-xs text-gray-400">
          Recording sets each component&apos;s cost from its date forward. Report rolls the COGS of shipped orders up by
          final product and by component, for the purchasing team. Inventory tracks each component&apos;s stock day by
          day, in KG / L / Pcs.
        </p>
      </div>
      <PurchasingTabs
        components={components}
        initialPurchases={purchases}
        openingRows={opening.rows}
        access={{
          recording: { view: canView(viewer, "purchasing:recording"), edit: canEdit(viewer, "purchasing:recording") },
          report: { view: canView(viewer, "purchasing:report"), edit: canEdit(viewer, "purchasing:report") },
          inventory: { view: canView(viewer, "purchasing:inventory"), edit: canEdit(viewer, "purchasing:inventory") },
        }}
      />
    </div>
  );
}
