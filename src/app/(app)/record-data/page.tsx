import { requirePageView } from "@/lib/access";
import { canEdit, canView } from "@/lib/permissions";
import { getAccountTypes, getExpenseRecords, getRecordDataSyncedAt } from "@/lib/record-data/expenses";
import { RecordDataTabs } from "../record-data-tabs";
import { NoAccess } from "../no-access";

export const dynamic = "force-dynamic";

export default async function RecordDataPage() {
  const viewer = await requirePageView("record-data");
  if (!viewer) return <NoAccess />;

  const [accountTypes, records, syncedAt] = await Promise.all([
    getAccountTypes(),
    getExpenseRecords(),
    getRecordDataSyncedAt(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Expense & Income</h1>
      </div>

      <RecordDataTabs
        accountTypes={accountTypes}
        records={records}
        syncedAt={syncedAt}
        canViewExpenses={canView(viewer, "record-data:expenses")}
        canEditExpenses={canEdit(viewer, "record-data:expenses")}
        canViewReport={canView(viewer, "record-data:report")}
      />
    </div>
  );
}
