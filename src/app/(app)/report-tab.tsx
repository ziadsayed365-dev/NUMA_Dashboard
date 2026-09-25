"use client";

import { useMemo, useState } from "react";
import { egyptToday } from "@/lib/dates";
import type { AccountType, ExpenseRecord } from "@/lib/record-data/expenses";

// Same signed convention as the Expense & Income tab: income positive,
// expense negative, so summing straight down the Amount column always
// gives the right subtotal/Net Cash Flow without special-casing signs.
function fmtAmount(n: number): string {
  const formatted = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return (n < 0 ? `-${formatted}` : formatted) + " EGP";
}

function fmtPct(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

type Row = { id: number; name: string; amount: number };

function fmtSyncedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function ReportTab({
  accountTypes,
  records,
  syncedAt,
}: {
  accountTypes: AccountType[];
  records: ExpenseRecord[];
  syncedAt: string | null;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(egyptToday());

  // The report only reflects entries last touched at or before the last
  // Sync (owner-only) - new or edited entries wait for the next Sync
  // instead of shifting the report while it's being reviewed.
  const synced = useMemo(
    () => (syncedAt ? records.filter((r) => r.updatedAt <= syncedAt) : []),
    [records, syncedAt]
  );

  const filtered = useMemo(
    () => synced.filter((r) => (!from || r.date >= from) && (!to || r.date <= to)),
    [synced, from, to]
  );

  const sumByAccount = useMemo(() => {
    const map = new Map<number, number>();
    for (const r of filtered) {
      const signed = r.type === "expense" ? -r.amount : r.amount;
      map.set(r.accountTypeId, (map.get(r.accountTypeId) ?? 0) + signed);
    }
    return map;
  }, [filtered]);

  // Biggest account to smallest, by magnitude - expense amounts are
  // stored negative, so this sorts by |amount|, not the signed value.
  const byMagnitudeDesc = (a: Row, b: Row) => Math.abs(b.amount) - Math.abs(a.amount);

  const incomeRows: Row[] = accountTypes
    .filter((t) => t.type === "income")
    .map((t) => ({ id: t.id, name: t.name, amount: sumByAccount.get(t.id) ?? 0 }))
    .sort(byMagnitudeDesc);
  const expenseRows: Row[] = accountTypes
    .filter((t) => t.type === "expense")
    .map((t) => ({ id: t.id, name: t.name, amount: sumByAccount.get(t.id) ?? 0 }))
    .sort(byMagnitudeDesc);

  const totalIncome = incomeRows.reduce((sum, r) => sum + r.amount, 0);
  const totalExpense = expenseRows.reduce((sum, r) => sum + r.amount, 0);
  const netCashFlow = totalIncome + totalExpense;

  // Common-size analysis: every line as a percentage of Total Cash In
  // (Total Income), the same base used throughout - including expense
  // lines, Total Expense, and Net Cash Flow.
  function pctOfCashIn(amount: number): number | null {
    return totalIncome !== 0 ? (amount / totalIncome) * 100 : null;
  }

  const inputClass = "mt-1 rounded border border-gray-300 px-2 py-1 text-sm";
  const pendingCount = records.length - synced.length;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {syncedAt ? (
          <>
            Showing data as of the last Sync ({fmtSyncedAt(syncedAt)}).
            {pendingCount > 0 && ` ${pendingCount} new/edited entr${pendingCount === 1 ? "y" : "ies"} will appear after the next Sync.`}
          </>
        ) : (
          "No Sync has run yet - this report will stay empty until the owner clicks Sync."
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <label className="block text-xs font-medium text-gray-500">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </div>
        {from && (
          <button type="button" onClick={() => setFrom("")} className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700">
            Clear from (all time)
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-400">
            <tr>
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">% of Cash In</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {incomeRows.map((r) => (
              <tr key={r.id} className="text-gray-700">
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2 text-right text-green-700">{fmtAmount(r.amount)}</td>
                <td className="px-3 py-2 text-right text-gray-500">{fmtPct(pctOfCashIn(r.amount))}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-900">
              <td className="px-3 py-2">Total Income</td>
              <td className="px-3 py-2 text-right text-green-700">{fmtAmount(totalIncome)}</td>
              <td className="px-3 py-2 text-right">{fmtPct(pctOfCashIn(totalIncome))}</td>
            </tr>

            {expenseRows.map((r) => (
              <tr key={r.id} className="text-gray-700">
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2 text-right text-red-700">{fmtAmount(r.amount)}</td>
                <td className="px-3 py-2 text-right text-gray-500">{fmtPct(pctOfCashIn(r.amount))}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-900">
              <td className="px-3 py-2">Total Expense</td>
              <td className="px-3 py-2 text-right text-red-700">{fmtAmount(totalExpense)}</td>
              <td className="px-3 py-2 text-right">{fmtPct(pctOfCashIn(totalExpense))}</td>
            </tr>

            <tr className={`border-t-2 border-gray-400 font-bold ${netCashFlow >= 0 ? "text-green-700" : "text-red-700"}`}>
              <td className="px-3 py-2">Net Cash Flow</td>
              <td className="px-3 py-2 text-right">{fmtAmount(netCashFlow)}</td>
              <td className="px-3 py-2 text-right">{fmtPct(pctOfCashIn(netCashFlow))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
