import { cookies } from "next/headers";
import { requirePageView } from "@/lib/access";
import { canEdit, canView } from "@/lib/permissions";
import { NoAccess } from "./no-access";
import { getDailyPnl } from "@/lib/reports/daily-pnl";
import { getProductOptions } from "@/lib/reports/per-product";
import { getMissingTikTokDays } from "@/lib/tiktok-spend";
import { getPerfExpenseHistory, getRecordedExpensesByMonth } from "@/lib/settings/fixed-expenses";
import { egyptToday, daysAgo, addDays } from "@/lib/dates";
import { IncomeStatementTabs } from "./income-statement-tabs";
import { TikTokSpendModal } from "./tiktok-spend-modal";
import { ExportPdfModal } from "./export-pdf-modal";

export const dynamic = "force-dynamic";
// The full-history report rebuild behind this page can run well past the
// platform default on a cold cache (see REPORT_CACHE_SECONDS). Without this the
// first request after any sync is killed mid-render and the page reads as down.
export const maxDuration = 300;

const ALL_TIME_START = "2000-01-01";

export default async function DailyPnlPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const from = params.from ?? daysAgo(30);
  const to = params.to ?? egyptToday();
  const today = egyptToday();

  const viewer = await requirePageView("income-statement");
  if (!viewer) return <NoAccess />;

  // The "fill in TikTok spend" popup writes through Settings → Ad Allocation.
  const canRecordTikTok = canEdit(viewer, "settings:ads");

  // The date filter only scopes the summary cards. The table below browses
  // the full history independently, unaffected by this filter.
  const [
    performanceSummary,
    actualSummary,
    performanceAllTime,
    actualAllTime,
    missingTikTokDays,
    productOptions,
    perfHistory,
    recordedByMonth,
  ] = await Promise.all([
    getDailyPnl(from, to, "performance"),
    getDailyPnl(from, to, "actual"),
    getDailyPnl(ALL_TIME_START, today, "performance"),
    getDailyPnl(ALL_TIME_START, today, "actual"),
    canRecordTikTok ? getMissingTikTokDays() : Promise.resolve([]),
    canRecordTikTok ? getProductOptions() : Promise.resolve([]),
    getPerfExpenseHistory(),
    getRecordedExpensesByMonth(),
  ]);

  return (
    <div className="space-y-6">
      {canRecordTikTok && <TikTokSpendModal missingDays={missingTikTokDays} products={productOptions} />}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Income Statement</h1>
        <ExportPdfModal defaultTo={addDays(today, -1)} />
      </div>

      <IncomeStatementTabs
        performance={{
          totals: performanceSummary.totals,
          rows: performanceAllTime.rows,
          openMonthInfo: performanceAllTime.openMonthInfo,
          expectedDeliveryRate: performanceAllTime.expectedDeliveryRate,
        }}
        actual={{
          totals: actualSummary.totals,
          rows: actualAllTime.rows,
          openMonthInfo: actualAllTime.openMonthInfo,
          expectedDeliveryRate: actualAllTime.expectedDeliveryRate,
        }}
        from={from}
        to={to}
        perfHistory={perfHistory}
        recordedByMonth={recordedByMonth}
        canViewPerformance={canView(viewer, "income-statement:performance")}
        canViewActual={canView(viewer, "income-statement:actual")}
      />
    </div>
  );
}
