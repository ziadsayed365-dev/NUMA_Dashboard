"use client";

import { useEffect, useState } from "react";
import type { DailyPnlRow, OpenMonthInfo } from "@/lib/reports/daily-pnl";
import type { PerfExpenseHistory, RecordedExpensesByMonth } from "@/lib/settings/perf-expenses";
import { egyptToday, firstOfMonth } from "@/lib/dates";
import { buildLines, LineRow, fmtMonthShort } from "./weekly-table";

// Monthly Income Statement starts here per Ziad's request - earlier data
// isn't presented month-by-month.
const MONTHLY_START = "2026-01";
// Show up to 7 months at once; once more than 7 exist the ◀ ▶ arrows shuffle
// back to January / forward to the current month.
const WINDOW_DESKTOP = 7;
const WINDOW_MOBILE = 3;

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    setIsMobile(query.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

function fmtMonthLong(month: string): string {
  const date = new Date(month + "-01T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function emptyMonth(month: string): DailyPnlRow {
  return {
    date: month, // "YYYY-MM" - column key/label only, never a real day
    ordersPlaced: 0,
    ordersResolved: 0,
    ordersReceived: 0,
    ordersDelivered: 0,
    itemsSold: 0,
    revenue: 0,
    cogs: 0,
    grossRevenue: 0,
    grossCogs: 0,
    grossProfit: 0,
    adSpend: 0,
    adSpendMeta: 0,
    adSpendTiktok: 0,
    contributionProfit: 0,
    packaging: 0,
    transportation: 0,
    shippingFeeCharged: 0,
    bostaFeesPaid: 0,
    shippingDifferencesFee: 0,
    salaries: 0,
    rent: 0,
    bostaPenalty: 0,
  };
}

const SUMMABLE_KEYS: (keyof Omit<DailyPnlRow, "date">)[] = [
  "ordersPlaced",
  "ordersResolved",
  "ordersReceived",
  "ordersDelivered",
  "itemsSold",
  "revenue",
  "cogs",
  "grossRevenue",
  "grossCogs",
  "grossProfit",
  "adSpend",
  "adSpendMeta",
  "adSpendTiktok",
  "contributionProfit",
  "packaging",
  "transportation",
  "shippingFeeCharged",
  "bostaFeesPaid",
  "shippingDifferencesFee",
  "salaries",
  "rent",
  "bostaPenalty",
];

// Rolls the all-time daily rows up into one column per calendar month (from
// MONTHLY_START onward). Only months that actually have activity get a column -
// months with no data (e.g. Jan-Mar 2026, before any orders existed) are
// skipped rather than shown as empty zero columns. Every figure is additive
// across days - salaries and rent are already spread per-day in daily-pnl.ts,
// so summing them yields the correct monthly total - and the table recomputes
// margins/net from these aggregates, so a plain sum is exact.
function aggregateMonthly(rows: DailyPnlRow[]): DailyPnlRow[] {
  const byMonth = new Map<string, DailyPnlRow>();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    if (month < MONTHLY_START) continue;
    let m = byMonth.get(month);
    if (!m) {
      m = emptyMonth(month);
      byMonth.set(month, m);
    }
    for (const k of SUMMABLE_KEYS) m[k] += r[k];
  }
  return [...byMonth.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function MonthlyTable({
  rows,
  openMonthInfo,
  flatFixedExpenses,
  perfHistory,
  recordedByMonth,
}: {
  rows: DailyPnlRow[];
  openMonthInfo: OpenMonthInfo | null;
  flatFixedExpenses?: boolean;
  perfHistory?: PerfExpenseHistory;
  recordedByMonth?: RecordedExpensesByMonth;
}) {
  const isMobile = useIsMobile();
  const WINDOW = isMobile ? WINDOW_MOBILE : WINDOW_DESKTOP;
  const [endIndexOverride, setEndIndexOverride] = useState<number | null>(null);

  const months = aggregateMonthly(rows);
  if (months.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-400">No monthly data yet.</div>;
  }

  const endIndex = endIndexOverride === null ? months.length : Math.min(endIndexOverride, months.length);
  const start = Math.max(0, endIndex - WINDOW);
  const window = months.slice(start, endIndex);
  const canGoEarlier = start > 0;
  const canGoLater = endIndex < months.length;

  function shiftWindow(delta: number) {
    const next = Math.min(months.length, Math.max(WINDOW, endIndex + delta));
    setEndIndexOverride(next);
  }

  const openMonth = openMonthInfo ? openMonthInfo.month.slice(0, 7) : null;
  const windowTouchesOpenMonth = openMonth !== null && window.some((r) => r.date >= openMonth);
  const openMonthOrders =
    openMonth !== null
      ? months
          .filter((r) => r.date >= openMonth)
          .reduce((acc, r) => ({ placed: acc.placed + r.ordersPlaced, resolved: acc.resolved + r.ordersResolved }), {
            placed: 0,
            resolved: 0,
          })
      : null;

  // A month is "closed" once it's a past calendar month; the current calendar
  // month is still open and uses the Settings average.
  const openMonthStart = firstOfMonth(egyptToday());
  const lines = buildLines(window, { flatFixedExpenses, monthly: true, perfHistory, recordedByMonth, openMonthStart });

  return (
    <div className="space-y-2">
      {windowTouchesOpenMonth && openMonthInfo && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fmtMonthLong(openMonth!)} is still settling - figures are projected using{" "}
          {openMonthInfo.sourceMonth ? fmtMonthLong(openMonthInfo.sourceMonth.slice(0, 7)) : "the default"}&apos;s delivery rate (
          {(openMonthInfo.rate * 100).toFixed(1)}%), not yet real per-order outcomes.{" "}
          {openMonthOrders && openMonthOrders.placed > 0 && (
            <>
              {openMonthOrders.resolved}/{openMonthOrders.placed} orders resolved so far (
              {((openMonthOrders.resolved / openMonthOrders.placed) * 100).toFixed(1)}%).
            </>
          )}
        </div>
      )}
      {(canGoEarlier || canGoLater) && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-gray-500">
            {fmtMonthShort(window[0].date + "-01")} – {fmtMonthShort(window[window.length - 1].date + "-01")}
          </span>
          <button
            type="button"
            disabled={!canGoEarlier}
            onClick={() => shiftWindow(-1)}
            className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Earlier month"
          >
            ◀
          </button>
          <button
            type="button"
            disabled={!canGoLater}
            onClick={() => shiftWindow(1)}
            className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Later month"
          >
            ▶
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
              {window.map((r) => (
                <th key={r.date} className="px-4 py-2 text-right text-sm font-semibold text-gray-900">
                  {fmtMonthShort(r.date + "-01")}
                </th>
              ))}
              <th className="border-l-2 border-l-gray-400 px-4 py-2 text-right text-sm font-semibold text-gray-900">Total</th>
            </tr>
          </thead>
          <tbody>
            {/* Keyed by index, not label: the Actual and Meta Dashboard ratio
                blocks deliberately repeat ROAS / CPA / CPA Limit / Fixed Cost. */}
            {lines.map((line, i) => (
              <LineRow key={i} line={line} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
