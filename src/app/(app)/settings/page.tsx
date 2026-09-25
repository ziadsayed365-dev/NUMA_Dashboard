import { requirePageView } from "@/lib/access";
import { canEdit, canView } from "@/lib/permissions";
import { getUsers } from "@/lib/settings/users";
import { getPerfExpenseHistory } from "@/lib/settings/fixed-expenses";
import { getAdAllocations } from "@/lib/reports/ad-allocation";
import { getProductOptions } from "@/lib/reports/per-product";
import { getFixedAssets } from "@/lib/settings/fixed-assets";
import { SettingsPage } from "../settings-page";
import { NoAccess } from "../no-access";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const viewer = await requirePageView("settings");
  if (!viewer) return <NoAccess />;

  const [users, perfHistory, adAllocations, productOptions, fixedAssets] = await Promise.all([
    getUsers(),
    getPerfExpenseHistory(),
    getAdAllocations(),
    getProductOptions(),
    getFixedAssets(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
      </div>

      <SettingsPage
        users={users}
        perfHistory={perfHistory}
        adAllocations={adAllocations}
        productOptions={productOptions}
        fixedAssets={fixedAssets}
        isOwner={viewer.isOwner}
        access={{
          expenses: { view: canView(viewer, "settings:expenses"), edit: canEdit(viewer, "settings:expenses") },
          ads: { view: canView(viewer, "settings:ads"), edit: canEdit(viewer, "settings:ads") },
          assets: { view: canView(viewer, "settings:assets"), edit: canEdit(viewer, "settings:assets") },
          users: { view: canView(viewer, "settings:users"), edit: canEdit(viewer, "settings:users") },
        }}
      />
    </div>
  );
}
