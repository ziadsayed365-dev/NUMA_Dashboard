"use client";

import { useEffect } from "react";
import type { DailyPnlRow, ExpectedDeliveryRate } from "@/lib/reports/daily-pnl";
import type { ProductReportRow } from "@/lib/reports/per-product";
import type { PerfExpenseHistory } from "@/lib/settings/perf-expenses";
import { buildLines, LineRow } from "@/app/(app)/weekly-table";
import { egyptToday } from "@/lib/dates";

const BRAND_NAVY = "#050a30";

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
}
function fmtLongDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}
function dayCount(from: string, to: string): number {
  const ms = Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z");
  if (Number.isNaN(ms)) return 0;
  return Math.max(1, Math.floor(ms / 86_400_000) + 1);
}
function fmtMonthShort(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

// CSS printed into the standalone page: portrait A4, keep the on-screen
// colours/backgrounds (browsers strip them from print by default), and hide the
// on-screen-only toolbar.
const PRINT_CSS = `
  @page { size: A4 portrait; margin: 10mm; }
  @media print {
    .no-print { display: none !important; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`;

export function PrintReport({
  window: cols,
  showIncome,
  showProduct,
  products,
  perfHistory,
  expectedDeliveryRate,
  from,
  to,
  autoPrint = true,
}: {
  window: DailyPnlRow[];
  showIncome: boolean;
  showProduct: boolean;
  products: ProductReportRow[] | null;
  // Both null on a product-only export, which never loads the daily P&L.
  perfHistory: PerfExpenseHistory | null;
  // Day columns, so the Delivery Rate line shows the last closed month's real
  // rate rather than each day's own near-0% arithmetic - same as the on-screen
  // daily view. See buildLines.
  expectedDeliveryRate: ExpectedDeliveryRate | null;
  from: string;
  to: string;
  autoPrint?: boolean;
}) {
  // Auto-open the print dialog once the page has painted. A short delay lets
  // fonts/layout settle so the PDF isn't captured mid-render. Suppressed
  // (?auto=0) when the headless PDF job renders this page - there Chromium
  // drives printing itself via page.pdf(), and a stray window.print() can stall
  // the render.
  useEffect(() => {
    if (!autoPrint) return;
    const t = setTimeout(() => window.print(), 500);
    return () => clearTimeout(t);
  }, [autoPrint]);

  // The Income Statement needs day columns; Analysis by Product doesn't, so a
  // product-only export still prints when no daily P&L rows fall in the range.
  if (cols.length === 0 && !showProduct) {
    return <div className="p-8 text-sm text-gray-600">No data in the selected range.</div>;
  }

  // Only built when the Income Statement is included - a product-only export
  // never loads the P&L inputs these lines are computed from.
  const lines =
    showIncome && perfHistory && expectedDeliveryRate
      ? buildLines(cols, { flatFixedExpenses: true, monthly: false, perfHistory, expected: expectedDeliveryRate })
      : [];
  // Day columns when the Income Statement drives the layout, otherwise the full
  // span the product totals cover.
  const days = showIncome ? cols.length : dayCount(from, to);
  const title =
    showIncome && showProduct ? "Income Statement & Product Analysis" : showProduct ? "Analysis by Product" : "Income Statement";

  return (
    <div className="mx-auto max-w-none bg-white p-6 text-gray-900">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="no-print mb-4 flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2">
        <span className="text-xs text-gray-500">Use your browser&apos;s dialog to save as PDF. It should open automatically.</span>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          Print / Save as PDF
        </button>
      </div>

      {/* Each data-pdf-page block is scaled to fit one A4 page by the headless
          PDF job (src/lib/report-pdf.ts). */}
      <div data-pdf-page="income">
      <header className="mb-4 flex items-end justify-between border-b-2 pb-2" style={{ borderColor: BRAND_NAVY }}>
        <div>
          <div className="text-lg font-bold" style={{ color: BRAND_NAVY }}>
            NUMA — {title}
          </div>
          <div className="text-xs text-gray-500">
            {fmtLongDate(from)} – {fmtLongDate(to)} · {days} {days === 1 ? "day" : "days"}
          </div>
        </div>
        <div className="text-right text-[10px] text-gray-400">Generated {fmtLongDate(egyptToday())}</div>
      </header>

      {/* Income Statement — same lines/rendering as the on-screen daily view. */}
      {showIncome && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
              {cols.map((r) => (
                <th key={r.date} className="px-3 py-2 text-right text-sm font-semibold text-gray-900">
                  {fmtDate(r.date)}
                </th>
              ))}
              <th className="border-l-2 border-l-gray-400 px-3 py-2 text-right text-sm font-semibold text-gray-900">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <LineRow key={i} line={line} />
            ))}
          </tbody>
        </table>
      )}
      </div>

      {showProduct && products && <ProductAnalysis products={products} newPage={showIncome} />}
    </div>
  );
}

// Static reproduction of the Analysis by Product "All Products" table, matching
// analysis-by-product-tabs.tsx. Rendered on a fresh page when the Income
// Statement is also included.
function ProductAnalysis({ products, newPage }: { products: ProductReportRow[]; newPage: boolean }) {
  const sorted = [...products].sort((a, b) => b.revenue - a.revenue);

  const totals = sorted.reduce(
    (t, p) => ({
      ordersPlaced: t.ordersPlaced + p.ordersPlaced,
      ordersResolved: t.ordersResolved + p.ordersResolved,
      revenue: t.revenue + p.revenue,
      cogs: t.cogs + p.cogs,
      grossProfit: t.grossProfit + p.grossProfit,
      adSpend: t.adSpend + p.adSpend,
      contributionProfit: t.contributionProfit + p.contributionProfit,
    }),
    { ordersPlaced: 0, ordersResolved: 0, revenue: 0, cogs: 0, grossProfit: 0, adSpend: 0, contributionProfit: 0 }
  );

  return (
    <div data-pdf-page="product" style={newPage ? { breakBefore: "page" } : undefined} className={newPage ? "mt-8" : ""}>
      <h2 className="mb-2 text-base font-bold" style={{ color: BRAND_NAVY }}>
        Analysis by Product
      </h2>
      <table className="w-full table-fixed text-xs">
        <thead className="text-left text-[10px] font-medium uppercase text-gray-500">
          <tr className="border-b-2 border-gray-300 bg-gray-200">
            <th className="w-[24%] py-1.5 pl-2">Product</th>
            <th className="w-[8%] py-1.5 text-right">Ord.</th>
            <th className="w-[10%] py-1.5 text-right">Rate</th>
            <th className="w-[9%] py-1.5 text-right">Rev</th>
            <th className="w-[9%] py-1.5 text-right">COGS</th>
            <th className="w-[8%] py-1.5 text-right">GP</th>
            <th className="w-[7%] py-1.5 text-right">GPM%</th>
            <th className="w-[8%] py-1.5 text-right">Mark</th>
            <th className="w-[8%] py-1.5 text-right">NP</th>
            <th className="w-[9%] py-1.5 pr-2 text-right">NPM%</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map((p) => (
            <tr key={p.productId} className="text-gray-700">
              <td className="py-1 pl-2">
                {p.name}
                {p.isBundle && <span className="ml-1 text-[9px] uppercase text-indigo-700">bundle</span>}
              </td>
              <td className="py-1 text-right">
                {p.ordersResolved}/{p.ordersPlaced}
              </td>
              <td className="py-1 text-right text-gray-500">
                {p.openMonthRate === null
                  ? "—"
                  : `${(p.openMonthRate * 100).toFixed(0)}%${p.openMonthRateSourceMonth ? ` (${fmtMonthShort(p.openMonthRateSourceMonth)})` : ""}`}
              </td>
              <td className="py-1 text-right">{fmt(p.revenue)}</td>
              <td className="py-1 text-right">{fmt(p.cogs)}</td>
              <td className={`py-1 text-right ${p.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(p.grossProfit)}</td>
              <td className="py-1 text-right">{pct(p.grossProfit, p.revenue)}</td>
              <td className="py-1 text-right">{fmt(p.adSpend)}</td>
              <td className={`py-1 text-right ${p.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                {fmt(p.contributionProfit)}
              </td>
              <td className="py-1 pr-2 text-right">{pct(p.contributionProfit, p.revenue)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-300 bg-gray-100 font-semibold text-gray-900">
            <td className="py-1.5 pl-2">Total ({sorted.length})</td>
            <td className="py-1.5 text-right">
              {totals.ordersResolved}/{totals.ordersPlaced}
            </td>
            <td className="py-1.5 text-right text-gray-400">—</td>
            <td className="py-1.5 text-right">{fmt(totals.revenue)}</td>
            <td className="py-1.5 text-right">{fmt(totals.cogs)}</td>
            <td className={`py-1.5 text-right ${totals.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(totals.grossProfit)}</td>
            <td className="py-1.5 text-right">{pct(totals.grossProfit, totals.revenue)}</td>
            <td className="py-1.5 text-right">{fmt(totals.adSpend)}</td>
            <td className={`py-1.5 text-right ${totals.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
              {fmt(totals.contributionProfit)}
            </td>
            <td className="py-1.5 pr-2 text-right">{pct(totals.contributionProfit, totals.revenue)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
