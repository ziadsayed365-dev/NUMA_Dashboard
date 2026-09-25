import { requirePageView } from "@/lib/access";
import { canEdit, canView } from "@/lib/permissions";
import { NoAccess } from "../no-access";
import { getPerProductReport, getProductOptions } from "@/lib/reports/per-product";
import { getUnmappedAds } from "@/lib/reports/ad-allocation";
import { getDailyPnl, type DailyPnlResult } from "@/lib/reports/daily-pnl";
import { getPerfExpenseHistory } from "@/lib/settings/fixed-expenses";
import {
  resolvePerfExpensesForMonth,
  PERF_EXPENSE_ACCOUNTS,
  type PerfExpenseHistory,
} from "@/lib/settings/perf-expenses";
import { egyptToday, addDays, daysInMonth } from "@/lib/dates";
import { AnalysisByProductTabs } from "../analysis-by-product-tabs";
import { AdAllocationModal } from "../ad-allocation-modal";

export const dynamic = "force-dynamic";

const ALL_TIME_START = "2000-01-01";

// Fixed cost to spread across products, per item sold. The numerator is the same
// fixed-expense block the Income Statement's daily view shows - the "fixed"
// Settings accounts, each month's figure spread over that month's real day count
// - summed over the days that actually had activity in this window. The
// denominator is that same window's total items, so a product's share is `this x
// its items sold` and the per-product Fixed Cost / Order below reconciles to the
// P&L's own. Only days with orders appear in pnl.rows, which is what carries the
// items.
const FIXED_ACCOUNTS = PERF_EXPENSE_ACCOUNTS.filter((a) => a.section === "fixed");

function fixedCostPerItemFor(
  pnl: DailyPnlResult,
  perfHistory: PerfExpenseHistory
): number {
  const fixedCostTotal = pnl.rows.reduce((sum, r) => {
    const monthly = resolvePerfExpensesForMonth(perfHistory, r.date);
    const accounts = FIXED_ACCOUNTS.reduce((s, a) => s + monthly[a.key], 0);
    return sum + accounts / daysInMonth(r.date);
  }, 0);
  const totalItems = pnl.rows.reduce((sum, r) => sum + r.itemsSold, 0);
  return totalItems ? fixedCostTotal / totalItems : 0;
}

export default async function AnalysisByProductPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  // Default to yesterday only - today's data is still incomplete, and
  // yesterday is the most recently fully-settled day to review.
  const yesterday = addDays(egyptToday(), -1);
  const from = params.from && params.from.length > 0 ? params.from : yesterday;
  const to = params.to && params.to.length > 0 ? params.to : yesterday;

  const viewer = await requirePageView("products");
  if (!viewer) return <NoAccess />;

  // The "this ad needs a model" popup belongs to the same right as Settings →
  // Ad Allocation, which is what it writes through.
  const canAllocateAds = canEdit(viewer, "settings:ads");

  const [
    performance,
    actual,
    unmappedAds,
    productOptions,
    performancePnl,
    actualPnl,
    perfHistory,
  ] = await Promise.all([
    getPerProductReport(from, to, "performance"),
    getPerProductReport(from, to, "actual"),
    canAllocateAds ? getUnmappedAds() : Promise.resolve([]),
    getProductOptions(),
    getDailyPnl(from, to, "performance"),
    getDailyPnl(from, to, "actual"),
    getPerfExpenseHistory(),
  ]);

  return (
    <div className="space-y-6">
      {canAllocateAds && <AdAllocationModal ads={unmappedAds} products={productOptions} />}
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Analysis by Product</h1>
        <p className="text-xs text-gray-400">All amounts in EGP.</p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <label className="block text-xs font-medium text-gray-500">From</label>
          <input type="date" name="from" defaultValue={from === ALL_TIME_START ? "" : from} className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">To</label>
          <input type="date" name="to" defaultValue={to} className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm" />
        </div>
        <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700">
          Apply
        </button>
        <a
          href={`/products?from=${ALL_TIME_START}&to=${egyptToday()}`}
          className="px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
        >
          Show all time
        </a>
        <a href="/products" className="px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700">
          Reset to yesterday
        </a>
        <span className="text-xs text-gray-400">
          Showing: {from === ALL_TIME_START ? "all time" : from} → {to}
        </span>
      </form>

      <AnalysisByProductTabs
        performance={performance.products}
        actual={actual.products}
        performanceOpenMonthInfo={performance.openMonthInfo}
        actualOpenMonthInfo={actual.openMonthInfo}
        productOptions={productOptions}
        performanceFixedCostPerItem={fixedCostPerItemFor(performancePnl, perfHistory)}
        actualFixedCostPerItem={fixedCostPerItemFor(actualPnl, perfHistory)}
        canViewAll={canView(viewer, "products:all")}
        canViewRollforward={canView(viewer, "products:rollforward")}
      />
    </div>
  );
}
