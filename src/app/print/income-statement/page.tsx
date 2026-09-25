import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getDailyPnl, type DailyPnlRow, type ExpectedDeliveryRate } from "@/lib/reports/daily-pnl";
import { getPerProductReport, type ProductReportRow } from "@/lib/reports/per-product";
import { getPerfExpenseHistory } from "@/lib/settings/fixed-expenses";
import type { PerfExpenseHistory } from "@/lib/settings/perf-expenses";
import { egyptToday, addDays } from "@/lib/dates";
import { PrintReport } from "./print-report";

export const dynamic = "force-dynamic";
// An uncapped Analysis-by-Product range scans every line item in the window
// (~114k rows over the full history), so this page needs more than the default
// function budget on a cold cache.
export const maxDuration = 300;

const ALL_TIME_START = "2000-01-01";
const MAX_COLUMNS = 7;

// Standalone print/PDF view of the Income Statement and/or Analysis by Product.
// Opened in its own tab from the Export PDF modal; it has no app chrome (it
// lives outside the (app) route group) and auto-triggers the browser's print /
// Save-as-PDF dialog. Params:
//   from, to - the range to report on (inclusive). Default: yesterday only.
//              With the Income Statement included, one day = one column and the
//              range is capped at the last 7 days; Analysis by Product is a
//              single total over the range, so on its own the range is
//              unlimited.
//   is       - "1" to include the Income Statement.
//   product  - "1" to include Analysis by Product.
//   auto     - "0" to suppress the automatic print dialog (used by AI NUMA's
//              headless PDF job, which prints via Chromium's own page.pdf()).
export default async function IncomeStatementPrintPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; is?: string; product?: string; auto?: string }>;
}) {
  const params = await searchParams;

  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (!role) redirect("/login");

  const today = egyptToday();
  const to = params.to && params.to.length > 0 ? params.to : addDays(today, -1);
  const fromRaw = params.from && params.from.length > 0 ? params.from : to;
  const from = fromRaw <= to ? fromRaw : to;

  // Default to Income Statement if neither flag is set, so a bare URL still
  // shows something.
  let showIncome = params.is === "1";
  const showProduct = params.product === "1";
  if (!showIncome && !showProduct) showIncome = true;

  // Same source the on-screen Income Statement uses; the columns are exactly the
  // chosen days that have data, capped at the last 7. Skipped entirely for a
  // product-only export: this report reads the whole order history, and none of
  // it is rendered without the Income Statement, so paying for it there is what
  // pushed an uncapped range past the function timeout.
  let window: DailyPnlRow[] = [];
  let expectedDeliveryRate: ExpectedDeliveryRate | null = null;
  let perfHistory: PerfExpenseHistory | null = null;
  if (showIncome) {
    const pnl = await getDailyPnl(ALL_TIME_START, to, "performance");
    const inRange = pnl.rows.filter((r) => r.date >= from && r.date <= to);
    window = inRange.slice(Math.max(0, inRange.length - MAX_COLUMNS));
    expectedDeliveryRate = pnl.expectedDeliveryRate;
    perfHistory = await getPerfExpenseHistory();
  }

  // Header/report range: the first day column when the Income Statement drives
  // the layout, otherwise exactly what was asked for.
  const colFrom = showIncome && window.length > 0 ? window[0].date : from;

  let products: ProductReportRow[] | null = null;
  if (showProduct) {
    const report = await getPerProductReport(colFrom, to, "performance");
    products = report.products;
  }

  return (
    <PrintReport
      window={window}
      showIncome={showIncome}
      showProduct={showProduct}
      products={products}
      perfHistory={perfHistory}
      expectedDeliveryRate={expectedDeliveryRate}
      from={colFrom}
      to={to}
      autoPrint={params.auto !== "0"}
    />
  );
}
