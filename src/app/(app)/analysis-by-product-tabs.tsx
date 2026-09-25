"use client";

import { useState } from "react";
import { egyptToday, addDays } from "@/lib/dates";
import type { ProductReportRow, OpenMonthInfo, ProductOption, ProductDailyRow } from "@/lib/reports/per-product";

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// For figures that are undefined rather than zero (a per-order ratio with no
// orders behind it).
function fmtOrDash(n: number | null): string {
  return n === null ? "—" : fmt(n);
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function fmtMonth(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function fmtMonthShort(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

function fmtDay(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
}

const ROLLFORWARD_WINDOW = 7;

// A zeroed 7-day window ending at endDate - lets the Rollforward table render
// its structure before any product is picked (and while a fetch is in flight),
// so selecting a product just fills in the numbers.
function emptyWindow(endDate: string): ProductDailyRow[] {
  const rows: ProductDailyRow[] = [];
  for (let i = ROLLFORWARD_WINDOW - 1; i >= 0; i--) {
    rows.push({ date: addDays(endDate, -i), volume: 0, revenue: 0, cogs: 0, grossProfit: 0, adSpend: 0, contributionProfit: 0 });
  }
  return rows;
}

// One product's Key Ratios. The per-order figures are null when the product has
// no orders to divide by - rendered "—" rather than a misleading 0.
type KeyRatioRow = {
  id: number;
  name: string;
  aRoas: number;
  aBreakEven: number;
  aCpa: number | null;
  aFixedPerOrder: number | null;
  mRoas: number;
  mBreakEven: number;
  mCpa: number | null;
  mFixedPerOrder: number | null;
  cpaLimit: number | null;
};

const TABS = [
  { key: "performance" as const, label: "Performance", subtitle: "Every Shopify order, whether or not it has shipped yet." },
  { key: "actual" as const, label: "Actual", subtitle: "Only orders actually handed to Khazenly for delivery." },
];

export function AnalysisByProductTabs({
  performance,
  actual,
  performanceOpenMonthInfo,
  actualOpenMonthInfo,
  productOptions,
  performanceFixedCostPerItem,
  actualFixedCostPerItem,
  canViewAll,
  canViewRollforward,
}: {
  performance: ProductReportRow[];
  actual: ProductReportRow[];
  performanceOpenMonthInfo: OpenMonthInfo | null;
  actualOpenMonthInfo: OpenMonthInfo | null;
  productOptions: ProductOption[];
  // The Income Statement's fixed cost for this window, per item sold - each
  // product carries `this x its items sold`, which is what puts a Fixed Cost /
  // Order and a Break-Even ROAS on a single product. One per mode, since each
  // mode's window has its own active days and item count.
  performanceFixedCostPerItem: number;
  actualFixedCostPerItem: number;
  canViewAll: boolean;
  canViewRollforward: boolean;
}) {
  const [active, setActive] = useState<"performance" | "actual">("performance");
  // Two views within each mode: "all" (every product, most revenue first) and
  // "rollforward" (a 7-day breakdown for one typed-in product) - each one its
  // own permission, so a user can be given either or both.
  const views = ([canViewAll && "all", canViewRollforward && "rollforward"] as const).filter(
    (v): v is "all" | "rollforward" => v !== false
  );
  const [view, setView] = useState<"all" | "rollforward">(views[0]);
  const products = active === "performance" ? performance : actual;
  const openMonthInfo = active === "performance" ? performanceOpenMonthInfo : actualOpenMonthInfo;
  const tab = TABS.find((t) => t.key === active)!;
  const missingCostProducts = products.filter((p) => p.costMissing);

  // Column totals across every product in the window.
  const totals = products.reduce(
    (a, p) => ({
      ordersPlaced: a.ordersPlaced + p.ordersPlaced,
      ordersResolved: a.ordersResolved + p.ordersResolved,
      revenue: a.revenue + p.revenue,
      cogs: a.cogs + p.cogs,
      grossProfit: a.grossProfit + p.grossProfit,
      adSpend: a.adSpend + p.adSpend,
      contributionProfit: a.contributionProfit + p.contributionProfit,
    }),
    { ordersPlaced: 0, ordersResolved: 0, revenue: 0, cogs: 0, grossProfit: 0, adSpend: 0, contributionProfit: 0 }
  );

  // Key Ratios: only products that carry marketing spend - every figure here
  // divides by it, so a product with none has nothing to say. Same two blocks and
  // the same arithmetic as the Income Statement's, applied one product at a time.
  const fixedCostPerItem = active === "performance" ? performanceFixedCostPerItem : actualFixedCostPerItem;
  const keyRatioProducts = products.filter((p) => p.adSpend > 0);
  const safe = (num: number, den: number) => (den ? num / den : 0);
  // Per-ORDER figures need their own zero-denominator rule. `safe` returns 0,
  // which is right for ROAS (no revenue on real spend really is 0x) but a lie for
  // CPA: a product that burned budget and got no orders would read "CPA 0" - free
  // customers - when the truth is the exact opposite. Null renders as "—".
  const ratio = (num: number, den: number) => (den ? num / den : null);

  const keyRatioRows: KeyRatioRow[] = keyRatioProducts.map((p) => {
    const mkt = p.adSpend;
    const fixedCost = fixedCostPerItem * p.itemsSold;
    // The Actual basis is the product's gross figures haircut by its OWN delivery
    // rate - the same expected-delivered basis the Income Statement's daily view
    // uses, rather than this window's confirmed deliveries. A window this page is
    // usually pointed at (a day, a week) is far too short for its orders to have
    // settled, so counting only what has landed would read as near-zero revenue
    // against fully-spent budget.
    const rate = p.deliveryRate;
    const aRev = p.grossRevenue * rate;
    const aCogs = p.grossCogs * rate;
    const aOrders = p.ordersPlaced * rate;
    return {
      id: p.productId,
      name: p.name,
      aRoas: safe(aRev, mkt),
      aBreakEven: safe(aCogs + mkt + fixedCost, mkt),
      aCpa: ratio(mkt, aOrders),
      aFixedPerOrder: ratio(fixedCost, aOrders),
      mRoas: safe(p.grossRevenue, mkt),
      mBreakEven: safe(p.grossCogs + mkt + fixedCost, mkt),
      mCpa: ratio(mkt, p.ordersPlaced),
      mFixedPerOrder: ratio(fixedCost, p.ordersPlaced),
      // Per-order gross margin. The delivery haircut divides out of numerator and
      // denominator alike, so this is one number shared by both blocks - exactly
      // as in the Income Statement.
      cpaLimit: ratio(p.grossRevenue - p.grossCogs, p.ordersPlaced),
    };
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setActive(tb.key)}
            className={`px-4 py-2 text-sm font-medium ${
              active === tb.key ? "border-b-2 border-gray-900 text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div className="text-xs text-gray-400">{tab.subtitle}</div>

      {views.length > 1 && (
        <div className="inline-flex rounded-md border border-gray-300 p-0.5">
          {([
            ["all", "All Products"],
            ["rollforward", "Rollforward"],
          ] as const)
            .filter(([key]) => views.includes(key))
            .map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                className={`rounded px-3 py-1 text-sm font-medium ${
                  view === key ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {label}
              </button>
            ))}
        </div>
      )}

      {view === "rollforward" ? (
        <Rollforward key={active} productOptions={productOptions} mode={active} />
      ) : (
        <>
          {openMonthInfo && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {fmtMonth(openMonthInfo.month)} is still settling - revenue and COGS for that month are projected using each
              product&apos;s own last-mature-month delivery rate (see the Rate column below), not yet real per-order outcomes.
            </div>
          )}

          {missingCostProducts.length > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              <strong>No Product List cost entered — COGS is understated (profit overstated) for:</strong>{" "}
              {missingCostProducts.map((p) => p.name).join(", ")}
            </div>
          )}

          {/* Desktop: one row per product. Below sm the 10 columns overlap, so
              mobile gets a card per product with the same numbers folded in. */}
          <div className="hidden overflow-x-auto rounded-lg border border-gray-200 bg-white sm:block">
            <table className="w-full table-fixed text-xs">
              <thead className="text-left text-[10px] font-medium uppercase text-gray-400">
                <tr className="border-b border-gray-100">
                  <th className="w-[24%] py-2 pl-4">Product</th>
                  <th className="w-[8%] py-2">Ord.</th>
                  <th className="w-[10%] py-2">Rate</th>
                  <th className="w-[9%] py-2">Rev</th>
                  <th className="w-[9%] py-2">COGS</th>
                  <th className="w-[9%] py-2">GP</th>
                  <th className="w-[7%] py-2">GPM%</th>
                  <th className="w-[7%] py-2">Mark</th>
                  <th className="w-[8%] py-2">NP</th>
                  <th className="w-[9%] py-2">NPM%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {products.map((p) => (
                  <tr key={p.productId} className="text-gray-700">
                    <td className="py-1.5 pl-4">
                      <span className="text-gray-900">{p.name}</span>
                      {p.isBundle && (
                        <span className="ml-1.5 rounded bg-indigo-100 px-1 py-0.5 text-[9px] font-medium uppercase text-indigo-700">
                          Bundle
                        </span>
                      )}
                      {p.costMissing && <span className="ml-1.5 text-[10px] font-normal text-red-600">no cost</span>}
                    </td>
                    <td className="py-1.5">
                      {p.ordersResolved}/{p.ordersPlaced}
                    </td>
                    <td className="py-1.5 text-gray-500">
                      {p.openMonthRate === null
                        ? "—"
                        : `${(p.openMonthRate * 100).toFixed(0)}%${
                            p.openMonthRateSourceMonth ? ` (${fmtMonthShort(p.openMonthRateSourceMonth)})` : ""
                          }`}
                    </td>
                    <td className="py-1.5">{fmt(p.revenue)}</td>
                    <td className="py-1.5">{fmt(p.cogs)}</td>
                    <td className={`py-1.5 ${p.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(p.grossProfit)}</td>
                    <td className="py-1.5">{pct(p.grossProfit, p.revenue)}</td>
                    <td className="py-1.5">{fmt(p.adSpend)}</td>
                    <td className={`py-1.5 ${p.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                      {fmt(p.contributionProfit)}
                    </td>
                    <td className="py-1.5">{pct(p.contributionProfit, p.revenue)}</td>
                  </tr>
                ))}
                {products.length === 0 && (
                  <tr>
                    <td colSpan={10} className="py-3 pl-4 text-gray-400">
                      No products with orders in this range.
                    </td>
                  </tr>
                )}
              </tbody>
              {products.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-900">
                    <td className="py-2 pl-4">Total ({products.length})</td>
                    <td className="py-2">
                      {totals.ordersResolved}/{totals.ordersPlaced}
                    </td>
                    <td className="py-2 text-gray-400">—</td>
                    <td className="py-2">{fmt(totals.revenue)}</td>
                    <td className="py-2">{fmt(totals.cogs)}</td>
                    <td className={`py-2 ${totals.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(totals.grossProfit)}</td>
                    <td className="py-2">{pct(totals.grossProfit, totals.revenue)}</td>
                    <td className="py-2">{fmt(totals.adSpend)}</td>
                    <td className={`py-2 ${totals.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                      {fmt(totals.contributionProfit)}
                    </td>
                    <td className="py-2">{pct(totals.contributionProfit, totals.revenue)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Mobile: a card per product, plus a totals card. */}
          <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white sm:hidden">
            {products.map((p) => (
              <MobileProductCard
                key={p.productId}
                name={p.name + (p.isBundle ? " (Bundle)" : "")}
                ordersResolved={p.ordersResolved}
                ordersPlaced={p.ordersPlaced}
                rateLabel={
                  p.openMonthRate === null
                    ? null
                    : `${(p.openMonthRate * 100).toFixed(0)}%${
                        p.openMonthRateSourceMonth ? ` (${fmtMonthShort(p.openMonthRateSourceMonth)})` : ""
                      }`
                }
                revenue={p.revenue}
                cogs={p.cogs}
                grossProfit={p.grossProfit}
                adSpend={p.adSpend}
                contributionProfit={p.contributionProfit}
              />
            ))}
            {products.length === 0 && <div className="px-4 py-3 text-xs text-gray-400">No products with orders in this range.</div>}
            {products.length > 0 && (
              <MobileProductCard
                name={`Total (${products.length})`}
                bold
                ordersResolved={totals.ordersResolved}
                ordersPlaced={totals.ordersPlaced}
                rateLabel={null}
                revenue={totals.revenue}
                cogs={totals.cogs}
                grossProfit={totals.grossProfit}
                adSpend={totals.adSpend}
                contributionProfit={totals.contributionProfit}
              />
            )}
          </div>

          {keyRatioRows.length > 0 && (
            <div>
              <h3 className="mb-2 mt-2 text-sm font-semibold text-gray-900">Key Ratios</h3>
              <p className="mb-2 text-xs text-gray-400">
                Only products with marketing spend. Same calculation as the Income Statement&apos;s Actual and Meta Dashboard
                ratios, per product — Actual on each product&apos;s expected-delivered basis, Meta Dashboard on all orders.
              </p>
              {/* Desktop: both blocks side by side. Below sm that is 11 columns in
                  a phone width, so mobile gets the same two blocks stacked. */}
              <div className="hidden overflow-x-auto rounded-lg border border-gray-200 bg-white sm:block">
                <table className="w-full min-w-[820px] table-fixed text-[11px]">
                  <thead>
                    <tr className="border-b border-gray-100 text-[10px] font-semibold uppercase text-gray-500">
                      <th className="w-[18%] py-2 pl-3 text-left" />
                      <th className="border-l border-gray-200 py-2 text-center" colSpan={5}>
                        Actual Ratios
                      </th>
                      <th className="border-l border-gray-200 py-2 text-center" colSpan={5}>
                        Meta Dashboard Ratios
                      </th>
                    </tr>
                    <tr className="text-[10px] font-medium uppercase text-gray-400">
                      <th className="py-1.5 pl-3 text-left">Product</th>
                      <th className="border-l border-gray-200 py-1.5 text-right">ROAS</th>
                      <th className="py-1.5 text-right">BE ROAS</th>
                      <th className="py-1.5 text-right">CPA</th>
                      <th className="py-1.5 text-right">CPA Lim</th>
                      <th className="py-1.5 text-right">Fix/Ord</th>
                      <th className="border-l border-gray-200 py-1.5 text-right">ROAS</th>
                      <th className="py-1.5 text-right">BE ROAS</th>
                      <th className="py-1.5 text-right">CPA</th>
                      <th className="py-1.5 text-right">CPA Lim</th>
                      <th className="py-1.5 pr-3 text-right">Fix/Ord</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {keyRatioRows.map((r) => (
                      <tr key={r.id} className="text-gray-700">
                        <td className="py-1.5 pl-3">{r.name}</td>
                        <td className="border-l border-gray-200 py-1.5 text-right">{r.aRoas.toFixed(2)}</td>
                        <td className="py-1.5 text-right">{r.aBreakEven.toFixed(2)}</td>
                        <td className="py-1.5 text-right">{fmtOrDash(r.aCpa)}</td>
                        <td className="py-1.5 text-right">{fmtOrDash(r.cpaLimit)}</td>
                        <td className="py-1.5 text-right">{fmtOrDash(r.aFixedPerOrder)}</td>
                        <td className="border-l border-gray-200 py-1.5 text-right">{r.mRoas.toFixed(2)}</td>
                        <td className="py-1.5 text-right">{r.mBreakEven.toFixed(2)}</td>
                        <td className="py-1.5 text-right">{fmtOrDash(r.mCpa)}</td>
                        <td className="py-1.5 text-right">{fmtOrDash(r.cpaLimit)}</td>
                        <td className="py-1.5 pr-3 text-right">{fmtOrDash(r.mFixedPerOrder)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: the two blocks stacked instead of side by side. */}
              <div className="space-y-3 sm:hidden">
                <MobileRatioTable title="Actual Ratios" rows={keyRatioRows} section="actual" />
                <MobileRatioTable title="Meta Dashboard Ratios" rows={keyRatioRows} section="meta" />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One of the two stacked ratio blocks shown on mobile (the desktop view keeps
// them side by side). The blocks differ only in ROAS / BE ROAS / CPA / Fix per
// order; CPA Limit is delivery-independent and so identical in both.
function MobileRatioTable({ title, rows, section }: { title: string; rows: KeyRatioRow[]; section: "actual" | "meta" }) {
  const actual = section === "actual";
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-3 py-1.5 text-[10px] font-semibold uppercase text-gray-500">{title}</div>
      <table className="w-full table-fixed text-[11px]">
        <thead>
          <tr className="text-[10px] font-medium uppercase text-gray-400">
            <th className="w-[30%] py-1.5 pl-3 text-left">Product</th>
            <th className="py-1.5 text-right">ROAS</th>
            <th className="py-1.5 text-right">BE</th>
            <th className="py-1.5 text-right">CPA</th>
            <th className="py-1.5 text-right">Lim</th>
            <th className="py-1.5 pr-3 text-right">Fix/Ord</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((r) => (
            <tr key={r.id} className="text-gray-700">
              <td className="py-1.5 pl-3">{r.name}</td>
              <td className="py-1.5 text-right">{(actual ? r.aRoas : r.mRoas).toFixed(2)}</td>
              <td className="py-1.5 text-right">{(actual ? r.aBreakEven : r.mBreakEven).toFixed(2)}</td>
              <td className="py-1.5 text-right">{fmtOrDash(actual ? r.aCpa : r.mCpa)}</td>
              <td className="py-1.5 text-right">{fmtOrDash(r.cpaLimit)}</td>
              <td className="py-1.5 pr-3 text-right">{fmtOrDash(actual ? r.aFixedPerOrder : r.mFixedPerOrder)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Rollforward: type a product, pick it from the dropdown, and see a fixed
// 7-date-column breakdown (◀▶ shifts the window a day at a time, like the
// Income Statement). Data is fetched per product+window from
// /api/product-rollforward, in the active Performance/Actual mode.
function Rollforward({ productOptions, mode }: { productOptions: ProductOption[]; mode: "performance" | "actual" }) {
  const today = egyptToday();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ProductOption | null>(null);
  // Default to yesterday - today's data is still incomplete.
  const [endDate, setEndDate] = useState<string>(addDays(today, -1));
  const [rows, setRows] = useState<ProductDailyRow[] | null>(null);
  // The selected product's own delivery rate (drives the delivered-volume line),
  // and the mature month it came from - both returned alongside the rows.
  const [deliveryRate, setDeliveryRate] = useState<number | null>(null);
  const [rateSourceMonth, setRateSourceMonth] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Match on name or SKU, so you can find a product by its SKU when the name
  // doesn't ring a bell.
  const q = query.trim().toLowerCase();
  const matches = q
    ? productOptions
        .filter((o) => o.label.toLowerCase().includes(q) || (o.sku?.toLowerCase().includes(q) ?? false))
        .slice(0, 12)
    : [];

  async function fetchRows(productId: number, to: string, m: "performance" | "actual") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/product-rollforward?productId=${productId}&to=${to}&mode=${m}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to load");
      setRows(data.rows as ProductDailyRow[]);
      setDeliveryRate(typeof data.deliveryRate === "number" ? data.deliveryRate : null);
      setRateSourceMonth(typeof data.rateSourceMonth === "string" ? data.rateSourceMonth : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setRows(null);
      setDeliveryRate(null);
      setRateSourceMonth(null);
    } finally {
      setBusy(false);
    }
  }

  function selectProduct(o: ProductOption) {
    setSelected(o);
    setQuery(o.label);
    setOpen(false);
    fetchRows(o.id, endDate, mode);
  }

  function shift(delta: number) {
    const next = addDays(endDate, delta);
    if (next > today) return; // don't page into the future
    setEndDate(next);
    if (selected) fetchRows(selected.id, next, mode);
  }

  // Keep whatever rows are already loaded on screen until the next fetch
  // returns (the "Updating…" hint covers the in-flight gap), so shifting the
  // window doesn't blank the table to zeros and back. Only before the first
  // product is picked do we fall back to the zeroed window.
  const displayRows = rows ?? emptyWindow(endDate);

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <label className="block text-xs font-medium text-gray-500">Product</label>
        <input
          type="text"
          value={query}
          placeholder="Type a product name or SKU…"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
        />
        {open && matches.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
            {matches.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectProduct(o);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
                >
                  <span className="truncate">{o.label}</span>
                  {o.sku && <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">SKU {o.sku}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${selected ? "text-gray-900" : "text-gray-400"}`}>
          {selected ? selected.label : "No product selected"}
          {selected?.sku && <span className="ml-1.5 font-normal text-gray-400">(SKU {selected.sku})</span>}
        </span>
        <div className="flex items-center gap-2">
          {busy && <span className="text-xs text-gray-400">Updating…</span>}
          <span className="text-xs text-gray-500">
            {fmtDay(displayRows[0].date)} – {fmtDay(displayRows[displayRows.length - 1].date)}
          </span>
          <button
            type="button"
            onClick={() => shift(-1)}
            className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100"
            aria-label="Earlier day"
          >
            ◀
          </button>
          <button
            type="button"
            disabled={endDate >= today}
            onClick={() => shift(1)}
            className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Later day"
          >
            ▶
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <RollforwardTable rows={displayRows} deliveryRate={rows ? deliveryRate : null} rateSourceMonth={rateSourceMonth} />

      {!selected && <p className="text-xs text-gray-400">Type a product name above to fill in the numbers.</p>}
    </div>
  );
}

function RollforwardTable({
  rows,
  deliveryRate,
  rateSourceMonth,
}: {
  rows: ProductDailyRow[];
  deliveryRate: number | null;
  rateSourceMonth: string | null;
}) {
  const totalVolume = rows.reduce((a, r) => a + r.volume, 0);
  const totalRev = rows.reduce((a, r) => a + r.revenue, 0);
  const totalCogs = rows.reduce((a, r) => a + r.cogs, 0);
  const totalGP = rows.reduce((a, r) => a + r.grossProfit, 0);
  const totalAd = rows.reduce((a, r) => a + r.adSpend, 0);
  const totalCP = rows.reduce((a, r) => a + r.contributionProfit, 0);

  // Delivered-volume reference: units expected to actually deliver at THIS
  // product's own delivery rate (the same rate that projects Rev/COGS below),
  // not a flat 50%. Labelled with the rate and its source month so it's clear
  // where the number comes from. Hidden until a product (with a rate) is loaded.
  const ratePct = deliveryRate === null ? null : Math.round(deliveryRate * 100);
  const deliveredLabel =
    ratePct === null
      ? null
      : `Delivered Volume ${ratePct}%${rateSourceMonth ? ` (${fmtMonthShort(rateSourceMonth)})` : ""}`;

  const lines: { label: string; vals: number[]; total: number; pctLine: boolean; profit: boolean; bold?: boolean; small?: boolean }[] = [
    // Total items sold (units if every order delivered), then the same haircut
    // by this product's real delivery rate - both shown smaller as a reference
    // above the projected Rev.
    { label: "Total Volume 100%", vals: rows.map((r) => r.volume), total: totalVolume, pctLine: false, profit: false, small: true },
    ...(deliveryRate !== null && deliveredLabel
      ? [{ label: deliveredLabel, vals: rows.map((r) => r.volume * deliveryRate), total: totalVolume * deliveryRate, pctLine: false, profit: false, small: true }]
      : []),
    { label: "Rev", vals: rows.map((r) => r.revenue), total: totalRev, pctLine: false, profit: false },
    { label: "COGS", vals: rows.map((r) => r.cogs), total: totalCogs, pctLine: false, profit: false },
    { label: "Gross Profit", vals: rows.map((r) => r.grossProfit), total: totalGP, pctLine: false, profit: true, bold: true },
    {
      label: "Gross Margin",
      vals: rows.map((r) => (r.revenue ? (r.grossProfit / r.revenue) * 100 : NaN)),
      total: totalRev ? (totalGP / totalRev) * 100 : NaN,
      pctLine: true,
      profit: false,
    },
    { label: "Marketing Spend", vals: rows.map((r) => r.adSpend), total: totalAd, pctLine: false, profit: false },
    { label: "Contribution Profit", vals: rows.map((r) => r.contributionProfit), total: totalCP, pctLine: false, profit: true, bold: true },
    {
      label: "Contribution Margin",
      vals: rows.map((r) => (r.revenue ? (r.contributionProfit / r.revenue) * 100 : NaN)),
      total: totalRev ? (totalCP / totalRev) * 100 : NaN,
      pctLine: true,
      profit: false,
    },
  ];

  const cellText = (v: number, pctLine: boolean) => (pctLine ? (Number.isNaN(v) ? "—" : `${v.toFixed(1)}%`) : fmt(v));
  const colorCls = (v: number, profit: boolean) => (profit ? (v >= 0 ? "text-green-700" : "text-red-700") : "text-gray-900");

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-200">
            <th className="px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
            {rows.map((r) => (
              <th key={r.date} className="px-3 py-2 text-right text-sm font-semibold text-gray-900">
                {fmtDay(r.date)}
              </th>
            ))}
            <th className="border-l-2 border-l-gray-400 px-3 py-2 text-right text-sm font-semibold text-gray-900">Total</th>
            <th className="px-3 py-2 text-right text-sm font-semibold text-gray-900">Avg/day</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            // Money lines: mean per day across the window. Margin (%) lines:
            // averaging daily percentages is meaningless (idle days are blank),
            // so the per-period margin is the only sensible "average".
            const avg = line.pctLine ? line.total : line.total / (rows.length || 1);
            return (
              <tr key={line.label} className={`${line.bold ? "bg-gray-50" : ""}${line.small ? " text-xs" : ""}`}>
                <td className={`px-2 py-1.5 ${line.small ? "text-gray-500" : line.bold ? "font-bold text-gray-900" : "text-gray-700"}`}>
                  {line.label}
                </td>
                {line.vals.map((v, i) => (
                  <td key={i} className={`px-3 py-1.5 text-right ${line.bold ? "font-bold " : ""}${colorCls(v, line.profit)}`}>
                    {cellText(v, line.pctLine)}
                  </td>
                ))}
                <td
                  className={`border-l-2 border-l-gray-400 px-3 py-1.5 text-right ${line.bold ? "font-bold " : ""}${colorCls(
                    line.total,
                    line.profit
                  )}`}
                >
                  {cellText(line.total, line.pctLine)}
                </td>
                <td className={`px-3 py-1.5 text-right ${line.bold ? "font-bold " : ""}${colorCls(avg, line.profit)}`}>
                  {cellText(avg, line.pctLine)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Mobile-only stand-in for one table row - folds GPM%/NPM% into the
// Gross/Net Profit lines instead of giving them their own row, since the
// point is fewer, wider lines rather than the table's ten narrow columns.
function MobileProductCard({
  name,
  bold,
  ordersResolved,
  ordersPlaced,
  rateLabel,
  revenue,
  cogs,
  grossProfit,
  adSpend,
  contributionProfit,
}: {
  name: string;
  bold?: boolean;
  ordersResolved: number;
  ordersPlaced: number;
  rateLabel: string | null;
  revenue: number;
  cogs: number;
  grossProfit: number;
  adSpend: number;
  contributionProfit: number;
}) {
  return (
    <div className={`px-4 py-3 ${bold ? "bg-gray-50" : ""}`}>
      <div className="flex items-center justify-between">
        <span className={`text-sm ${bold ? "font-semibold text-gray-900" : "font-medium text-gray-800"}`}>{name}</span>
        <span className="text-xs text-gray-400">
          {ordersResolved}/{ordersPlaced} orders{rateLabel ? ` · ${rateLabel}` : ""}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-700">
        <MetricCell label="Revenue" value={fmt(revenue)} />
        <MetricCell label="COGS" value={fmt(cogs)} />
        <MetricCell
          label="Gross Profit"
          value={`${fmt(grossProfit)} (${pct(grossProfit, revenue)})`}
          valueClassName={grossProfit >= 0 ? "text-green-700" : "text-red-700"}
        />
        <MetricCell label="Marketing" value={fmt(adSpend)} />
        <div className="col-span-2 mt-0.5 flex items-baseline justify-between border-t border-gray-100 pt-1">
          <span className="text-gray-500">Net Profit</span>
          <span className={`font-semibold ${contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
            {fmt(contributionProfit)} ({pct(contributionProfit, revenue)})
          </span>
        </div>
      </div>
    </div>
  );
}

function MetricCell({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-gray-400">{label}</span>
      <span className={valueClassName ?? "text-gray-900"}>{value}</span>
    </div>
  );
}
