"use client";

import { useState } from "react";
import type { AccountType, ExpenseRecord } from "@/lib/record-data/expenses";
import { ExpensesTab } from "./expenses-tab";
import { ReportTab } from "./report-tab";

const TABS = [
  { key: "expenses" as const, label: "Expense & Income" },
  { key: "report" as const, label: "Report" },
];

export function RecordDataTabs({
  accountTypes,
  records,
  syncedAt,
  canViewExpenses,
  canEditExpenses,
  canViewReport,
}: {
  accountTypes: AccountType[];
  records: ExpenseRecord[];
  syncedAt: string | null;
  canViewExpenses: boolean;
  canEditExpenses: boolean;
  canViewReport: boolean;
}) {
  const tabs = TABS.filter((t) => (t.key === "expenses" ? canViewExpenses : canViewReport));
  const [active, setActive] = useState<"expenses" | "report">(tabs[0]?.key ?? "expenses");

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

      {active === "expenses" && <ExpensesTab accountTypes={accountTypes} initialRecords={records} canEdit={canEditExpenses} />}
      {active === "report" && <ReportTab accountTypes={accountTypes} records={records} syncedAt={syncedAt} />}
    </div>
  );
}
