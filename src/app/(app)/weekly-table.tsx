"use client";

import { useEffect, useState } from "react";
import type { DailyPnlRow, ExpectedDeliveryRate, OpenMonthInfo } from "@/lib/reports/daily-pnl";
import {
  emptyPerfExpenseHistory,
  resolvePerfExpensesForMonth,
  PERF_EXPENSE_ACCOUNTS,
  type PerfExpenseHistory,
  type PerfExpenseKey,
  type RecordedExpensesByMonth,
} from "@/lib/settings/perf-expenses";
import { daysInMonth, firstOfMonth } from "@/lib/dates";

const WINDOW_DESKTOP = 7;
const WINDOW_MOBILE = 3;
const BRAND_NAVY = "#050a30";

// Matches the app's sm: breakpoint (640px) used for the mobile nav - below
// it, the full 7-day table is too cramped/horizontally-scrolly to be
// useful, so it shows fewer day columns at once instead.
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

function fmtMoney(n: number): string {
  const rounded = Math.round(n);
  const abs = Math.abs(rounded).toLocaleString("en-US");
  return rounded < 0 ? `(${abs})` : abs;
}

function fmtDate(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function fmtMonth(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Compact header for month columns in the monthly view, e.g. "Jan 26".
export function fmtMonthShort(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function emptyRow(date: string): DailyPnlRow {
  return {
    date,
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

// Always returns exactly windowSize entries, padding with empty placeholder
// days (extending backward from the earliest real day) when fewer exist.
function padToWindow(realWindow: DailyPnlRow[], windowSize: number): DailyPnlRow[] {
  const missing = windowSize - realWindow.length;
  if (missing <= 0) return realWindow;

  const anchor = realWindow.length > 0 ? new Date(realWindow[0].date + "T00:00:00Z") : new Date();
  const padding: DailyPnlRow[] = [];
  for (let i = missing; i > 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - i);
    padding.push(emptyRow(d.toISOString().slice(0, 10)));
  }
  return [...padding, ...realWindow];
}

export type Line = {
  label: string;
  values: number[];
  // "decimal" = a 2dp multiple (ROAS, MER); "header" = a section title row with
  // no figures of its own (the two ratio blocks below).
  kind: "count" | "money-cost" | "money-profit" | "percent" | "ratio" | "decimal" | "header";
  ratioTotals?: number[]; // only for kind: "ratio" - values=resolved, ratioTotals=placed
  total?: number; // override for the Total column - needed for "percent"/"decimal" (a true rate over the window, not a sum/average of the columns'); everything else defaults to summing values
  bold?: boolean;
  band?: number; // rows sharing the same band number get a shared gray background
  blankBefore?: boolean;
  small?: boolean; // smaller, brand-navy styling
  subtotal?: boolean; // top border + red only when negative (Gross/Contribution/Net Profit)
};

const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

// Builds the Income Statement line items from a set of period columns (days
// for the daily view, months for the monthly view). Column-agnostic: it only
// reads the aggregated per-period figures, so the same rows/rendering are
// shared between WeeklyTable and MonthlyTable.
//
// opts.flatFixedExpenses (Performance tab): replaces the itemised below-
// contribution expense lines with the owner-set flat monthly fixed-expense
// accounts (resolved per column from opts.perfHistory), plus the real Shipping Differences / Bosta
// Penalty. opts.monthly tells it whether each column is a whole month (show the
// full monthly figure) or a single day (spread it across the month's days).
// A column zeroed out but keeping its date, for periods before an Actual view's
// start date (nothing was tracked yet, so everything reads 0).
function zeroRow(date: string): DailyPnlRow {
  return {
    date,
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

export function buildLines(
  rawCols: DailyPnlRow[],
  opts: {
    flatFixedExpenses?: boolean;
    monthly?: boolean;
    perfHistory?: PerfExpenseHistory;
    zeroBeforeDate?: string;
    // Monthly view only: real recorded expense totals per closed month, and the
    // first-of-month of the still-open month. Closed months (month < openMonthStart)
    // show recorded actuals per account; the open month uses the Settings average.
    recordedByMonth?: RecordedExpensesByMonth;
    openMonthStart?: string;
    // Daily view only: the last closed month's real delivery rate, shown in place
    // of each day's own. See the Delivery Rate lines below.
    expected?: ExpectedDeliveryRate;
  } = {}
): Line[] {
  // opts.zeroBeforeDate (Actual daily view): every column before this date reads
  // 0. Zeroing the rows here blanks every order-derived line; the flat fixed-
  // expense lines are separately zeroed for those columns in `spread` below.
  const cols = opts.zeroBeforeDate
    ? rawCols.map((r) => (r.date < opts.zeroBeforeDate! ? zeroRow(r.date) : r))
    : rawCols;

  const salaries = cols.map((r) => r.salaries);
  const rent = cols.map((r) => r.rent);
  const bostaPenalty = cols.map((r) => r.bostaPenalty);
  const transportation = cols.map((r) => r.transportation);
  const shippingDifferencesFee = cols.map((r) => r.shippingDifferencesFee);
  const packaging = cols.map((r) => r.packaging);
  const adSpendMeta = cols.map((r) => r.adSpendMeta);
  const adSpendTiktok = cols.map((r) => r.adSpendTiktok);
  const cogs = cols.map((r) => r.cogs);
  const revenue = cols.map((r) => r.revenue);
  const grossProfit = cols.map((r) => r.grossProfit);
  const contributionProfit = cols.map((r) => r.contributionProfit);
  const netProfit = cols.map(
    (r, i) =>
      r.contributionProfit - packaging[i] - transportation[i] - salaries[i] - rent[i] - bostaPenalty[i] + shippingDifferencesFee[i]
  );

  const revenueTotal = sum(revenue);
  const pctOfRevenueTotal = (n: number) => (revenueTotal ? (n / revenueTotal) * 100 : 0);

  // Delivered / every order that came in that period, cancellations included.
  // Its Total is a true rate over the whole window (delivered-sum / received-sum),
  // never an average of the columns' percentages. Same arithmetic in every column
  // including the still-open month: the delivered COUNT is a fact even where the
  // money on the row is projected.
  const deliveryRatePct = cols.map((r) => (r.ordersReceived ? (r.ordersDelivered / r.ordersReceived) * 100 : 0));
  const receivedTotal = sum(cols.map((r) => r.ordersReceived));
  const deliveredTotal = sum(cols.map((r) => r.ordersDelivered));

  // opts.expected replaces each column's own rate with one figure repeated across
  // all of them - the last closed month's real rate. The daily view passes it,
  // because a day's own ratio is meaningless: that day's orders have had no time
  // to be delivered but are all in its denominator, so every column would read
  // near 0%. The monthly view omits it and shows each month's own arithmetic. The
  // counts row underneath is the real per-column figure either way, so the
  // benchmark and what actually happened are both on screen.
  const expected = opts.expected;
  const expectedPct = expected?.rate != null ? expected.rate * 100 : null;

  const head: Line[] = [
    expectedPct !== null
      ? {
          // A rate, not a quantity - its Total is the same number, not a sum.
          label: `Delivery Rate (expected${expected?.month ? `, ${expected.month}` : ""})`,
          values: cols.map(() => expectedPct),
          total: expectedPct,
          kind: "percent",
          small: true,
        }
      : {
          label: "Delivery Rate",
          values: deliveryRatePct,
          total: receivedTotal ? (deliveredTotal / receivedTotal) * 100 : 0,
          kind: "percent",
          small: true,
        },
    {
      // The raw counts the rate above is built from, always the real per-column
      // figures. Note the denominator is every order received - so it is wider
      // than the Orders summary card, which drops cancellations.
      label: "Delivered / Orders",
      values: cols.map((r) => r.ordersDelivered),
      ratioTotals: cols.map((r) => r.ordersReceived),
      kind: "ratio",
      small: true,
    },
    { label: "Total Items Sold", values: cols.map((r) => r.itemsSold), kind: "count", small: true },
    { label: "Total Revenue", values: revenue, kind: "money-profit", band: 1, blankBefore: true },
    { label: "Total Cost", values: cogs.map((v) => -v), kind: "money-cost", band: 1 },
    { label: "Gross Profit", values: grossProfit, kind: "money-profit", bold: true, subtotal: true },
    {
      label: "Gross Margin %",
      values: grossProfit.map((v, i) => (revenue[i] ? (v / revenue[i]) * 100 : 0)),
      total: pctOfRevenueTotal(sum(grossProfit)),
      kind: "percent",
      small: true,
    },
    { label: "Meta Ads", values: adSpendMeta.map((v) => -v), kind: "money-cost", band: 2, blankBefore: true },
    { label: "TikTok Ads", values: adSpendTiktok.map((v) => -v), kind: "money-cost", band: 2 },
    { label: "Contribution Profit", values: contributionProfit, kind: "money-profit", bold: true, subtotal: true },
    {
      label: "Contribution Margin %",
      values: contributionProfit.map((v, i) => (revenue[i] ? (v / revenue[i]) * 100 : 0)),
      total: pctOfRevenueTotal(sum(contributionProfit)),
      kind: "percent",
      small: true,
    },
  ];

  const netMarginLine = (net: number[]): Line => ({
    label: "Net Margin %",
    values: net.map((v, i) => (revenue[i] ? (v / revenue[i]) * 100 : 0)),
    total: pctOfRevenueTotal(sum(net)),
    kind: "percent",
    small: true,
  });

  // ---------------------------------------------------------------------------
  // Actual + Meta Dashboard ratios, shown under Net Profit in BOTH the daily and
  // monthly views.
  //
  // Actual = the delivered basis, the money we really keep. Meta Dashboard = the
  // all-orders (100%-delivery) basis, which is what the ad platform reports back
  // and therefore the only basis you can sanity-check a campaign against. Both
  // divide the SAME marketing spend, so the gap between the two blocks is exactly
  // the delivery haircut.
  //
  // CPA Limit is per-order gross margin, which is delivery-independent (the
  // haircut divides out of numerator and denominator alike), so it is identical
  // in both blocks by construction - not a copy-paste slip.
  const marketing = cols.map((r) => r.adSpend);
  const grossRev = cols.map((r) => r.grossRevenue);
  const grossCogsArr = cols.map((r) => r.grossCogs); // COGS if every order delivered (100%)
  const placedArr = cols.map((r) => r.ordersPlaced);
  const safe = (num: number, den: number) => (den ? num / den : 0);
  const tMkt = sum(marketing);
  const tGrossRev = sum(grossRev);
  const tGrossCogs = sum(grossCogsArr);
  const tPlaced = sum(placedArr);

  // The Actual block is the Meta Dashboard block haircut by the delivery rate -
  // revenue, COGS and orders all scaled by the same figure - so the gap between
  // the two blocks is exactly the cost of orders that don't arrive.
  //
  // The rate used is per column, and is precisely the one the Delivery Rate row
  // at the top of this same table shows, so the reader can see the number that
  // produced the gap: each month's own delivered/received in the monthly view,
  // and the last closed month's expected rate in the daily view (a single day's
  // orders have had no time to be delivered, so its own ratio is near zero and
  // would make every figure below read as nonsense).
  //
  // Deliberately NOT built from `revenue`/`cogs`/`ordersDelivered`: on the
  // Performance tab those are already the 100%-delivery basis for every closed
  // month (see daily-pnl.ts - Performance books every order at full value), so
  // the Actual block would silently duplicate the Meta one.
  const expectedRate = opts.expected?.rate;
  const deliveryRate = cols.map((r) =>
    opts.monthly
      ? // No orders received = nothing went to a courier, so nothing could fail
        // to arrive. Haircutting by 0 would wipe the block out.
        r.ordersReceived
        ? r.ordersDelivered / r.ordersReceived
        : 1
      : expectedRate ?? 1
  );
  const realRev = grossRev.map((v, i) => v * deliveryRate[i]);
  const realCogs = grossCogsArr.map((v, i) => v * deliveryRate[i]);
  const realOrders = placedArr.map((v, i) => v * deliveryRate[i]);

  // Fixed cost is derived rather than passed in: it is whatever sits between
  // Contribution Profit and Net Profit on this view, so the block stays correct
  // whichever expense layout the caller used.
  const buildRatioLines = (netProfit: number[]): Line[] => {
    const fixedCost = cols.map((_, i) => contributionProfit[i] - netProfit[i]);
    const tFixed = sum(fixedCost);
    const tRealRev = sum(realRev);
    const tRealCogs = sum(realCogs);
    const tRealOrders = sum(realOrders);
    // CPA Limit = per-order gross margin: the most a customer may cost before the
    // order stops paying for itself.
    const cpaLimit = cols.map((_, i) => safe(realRev[i] - realCogs[i], realOrders[i]));
    const cpaLimitTotal = safe(tRealRev - tRealCogs, tRealOrders);
    // Break-Even ROAS = (COGS + Marketing + Fixed) / Marketing - the ROAS at which
    // revenue exactly covers every cost (net profit = 0), so anything above this
    // line is profitable overall. Actual uses the delivered-basis COGS; Meta
    // Dashboard uses the 100%-delivered COGS, matching its own revenue basis.
    const actualBreakEven = cols.map((_, i) => safe(realCogs[i] + marketing[i] + fixedCost[i], marketing[i]));
    const metaBreakEven = cols.map((_, i) => safe(grossCogsArr[i] + marketing[i] + fixedCost[i], marketing[i]));
    return [
      { label: "Actual Ratios", values: cols.map(() => 0), kind: "header", bold: true, blankBefore: true },
      {
        label: "ROAS",
        values: cols.map((_, i) => safe(realRev[i], marketing[i])),
        total: safe(tRealRev, tMkt),
        kind: "decimal",
        small: true,
      },
      {
        label: "Break-Even ROAS",
        values: actualBreakEven,
        total: safe(tRealCogs + tMkt + tFixed, tMkt),
        kind: "decimal",
        small: true,
      },
      {
        label: "CPA",
        values: cols.map((_, i) => safe(marketing[i], realOrders[i])),
        total: safe(tMkt, tRealOrders),
        kind: "money-profit",
        small: true,
      },
      { label: "CPA Limit", values: cpaLimit, total: cpaLimitTotal, kind: "money-profit", small: true },
      {
        label: "Fixed Cost / Order",
        values: cols.map((_, i) => safe(fixedCost[i], realOrders[i])),
        total: safe(tFixed, tRealOrders),
        kind: "money-profit",
        small: true,
      },
      { label: "Meta Dashboard Ratios", values: cols.map(() => 0), kind: "header", bold: true, blankBefore: true },
      {
        label: "ROAS",
        values: cols.map((_, i) => safe(grossRev[i], marketing[i])),
        total: safe(tGrossRev, tMkt),
        kind: "decimal",
        small: true,
      },
      {
        label: "Break-Even ROAS",
        values: metaBreakEven,
        total: safe(tGrossCogs + tMkt + tFixed, tMkt),
        kind: "decimal",
        small: true,
      },
      {
        label: "CPA",
        values: cols.map((_, i) => safe(marketing[i], placedArr[i])),
        total: safe(tMkt, tPlaced),
        kind: "money-profit",
        small: true,
      },
      { label: "CPA Limit", values: cpaLimit, total: cpaLimitTotal, kind: "money-profit", small: true },
      {
        label: "Fixed Cost / Order",
        values: cols.map((_, i) => safe(fixedCost[i], placedArr[i])),
        total: safe(tFixed, tPlaced),
        kind: "money-profit",
        small: true,
      },
    ];
  };

  // Flat fixed-expense layout. "fixed" expense accounts (Settings) sit above
  // Shipping Differences + Return Penalty; the "other" accounts (Other-Expense)
  // sit below Return Penalty. Net Profit = Contribution − fixed
  // expenses + Shipping Differences − Return Penalty − Other-Expense (+ any income-natured "other" account).
  if (opts.flatFixedExpenses) {
    const history = opts.perfHistory ?? emptyPerfExpenseHistory();
    const recorded = opts.recordedByMonth;
    const openMonthStart = opts.openMonthStart;

    // Per-column amount for one account. A CLOSED month in the monthly view (its
    // month before the open month) shows that account's real recorded total when
    // one exists. Otherwise the Settings average is used: the full monthly
    // figure in the monthly view, or spread across the month's days in the daily
    // view. The average is effective-dated, so past months keep the amount that
    // was in effect then.
    const perColumn = (key: PerfExpenseKey): number[] =>
      cols.map((r) => {
        if (opts.zeroBeforeDate && r.date < opts.zeroBeforeDate) return 0;
        const monthStart = firstOfMonth(r.date);
        // A closed month uses what was actually recorded for this account in
        // Expense & Income - but only when something was. With nothing recorded
        // it falls through to the Settings amount below, so every month carries
        // its fixed costs rather than reading 0 until someone types them in.
        const recordedAmount = recorded?.[monthStart]?.[key];
        if (opts.monthly && openMonthStart && monthStart < openMonthStart && recordedAmount !== undefined) {
          return recordedAmount;
        }
        const monthly = resolvePerfExpensesForMonth(history, r.date)[key];
        return opts.monthly ? monthly : monthly / daysInMonth(r.date);
      });

    const values = new Map(PERF_EXPENSE_ACCOUNTS.map((acc) => [acc.key, perColumn(acc.key)]));
    const val = (key: PerfExpenseKey) => values.get(key)!;
    const fixed = PERF_EXPENSE_ACCOUNTS.filter((a) => a.section === "fixed");
    const other = PERF_EXPENSE_ACCOUNTS.filter((a) => a.section === "other");

    const sumOf = (accs: typeof PERF_EXPENSE_ACCOUNTS) => cols.map((_, i) => accs.reduce((s, a) => s + val(a.key)[i], 0));
    const fixedSum = sumOf(fixed);
    const otherExpenseSum = sumOf(other.filter((a) => a.nature === "expense"));
    const otherIncomeSum = sumOf(other.filter((a) => a.nature === "income"));

    const netFlat = contributionProfit.map(
      (v, i) =>
        v -
        fixedSum[i] +
        shippingDifferencesFee[i] -
        bostaPenalty[i] -
        otherExpenseSum[i] +
        otherIncomeSum[i]
    );

    const cost = (label: string, vals: number[], blankBefore?: boolean): Line => ({
      label,
      values: vals.map((v) => -v),
      kind: "money-cost",
      band: 3,
      blankBefore,
    });
    // Income lines show as-is (positive adds to Net Profit); expense lines negate.
    const accountLine = (acc: (typeof PERF_EXPENSE_ACCOUNTS)[number], blankBefore?: boolean): Line =>
      acc.nature === "income"
        ? { label: acc.label, values: val(acc.key), kind: "money-profit", band: 3, blankBefore }
        : cost(acc.label, val(acc.key), blankBefore);

    return [
      ...head,
      ...fixed.map((a, i) => cost(a.label, val(a.key), i === 0)),
      { label: "Shipping Differences", values: shippingDifferencesFee, kind: "money-profit", band: 3 },
      cost("Return Penalty", bostaPenalty),
      ...other.map((a) => accountLine(a)),
      { label: "Net Profit", values: netFlat, kind: "money-profit", bold: true, subtotal: true },
      netMarginLine(netFlat),
      ...buildRatioLines(netFlat),
    ];
  }

  return [
    ...head,
    { label: "Salaries", values: salaries.map((v) => -v), kind: "money-cost", band: 3, blankBefore: true },
    { label: "Rent", values: rent.map((v) => -v), kind: "money-cost", band: 3 },
    { label: "Packaging", values: packaging.map((v) => -v), kind: "money-cost", band: 3 },
    { label: "Transportation", values: transportation.map((v) => -v), kind: "money-cost", band: 3 },
    { label: "Shipping Differences Fee", values: shippingDifferencesFee, kind: "money-profit", band: 3 },
    { label: "Return Penalty", values: bostaPenalty.map((v) => -v), kind: "money-cost", band: 3 },
    { label: "Net Profit", values: netProfit, kind: "money-profit", bold: true, subtotal: true },
    netMarginLine(netProfit),
    ...buildRatioLines(netProfit),
  ];
}

export function WeeklyTable({
  rows,
  openMonthInfo,
  expectedDeliveryRate,
  endDate,
  onEndDateChange,
  flatFixedExpenses,
  perfHistory,
  zeroBeforeDate,
}: {
  rows: DailyPnlRow[];
  openMonthInfo: OpenMonthInfo | null;
  // The last closed month's delivery rate, shown in place of each day's own -
  // see buildLines. Daily view only; the monthly view uses real per-month rates.
  expectedDeliveryRate: ExpectedDeliveryRate;
  flatFixedExpenses?: boolean;
  perfHistory?: PerfExpenseHistory;
  zeroBeforeDate?: string;
  // Shared with the Performance/Actual tab toggle (lifted to IncomeStatementTabs)
  // so switching tabs keeps browsing the same calendar window instead of
  // always snapping back to the latest days - each mode's rows array has
  // different (sparser) dates, so the window is looked up by date, not by
  // array index, and stays meaningful across tabs. null = show the latest.
  endDate: string | null;
  onEndDateChange: (date: string) => void;
}) {
  const isMobile = useIsMobile();
  const WINDOW = isMobile ? WINDOW_MOBILE : WINDOW_DESKTOP;

  if (rows.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-400">No orders in this date range.</div>;
  }

  const firstAfterEndDate = endDate ? rows.findIndex((r) => r.date > endDate) : -1;
  const endIndex = firstAfterEndDate === -1 ? rows.length : firstAfterEndDate;

  const start = Math.max(0, endIndex - WINDOW);
  const window = padToWindow(rows.slice(start, endIndex), WINDOW);
  const canGoEarlier = start > 0;
  const canGoLater = endIndex < rows.length;

  function shiftWindow(delta: number) {
    const newEndIndex = Math.min(rows.length, Math.max(WINDOW, endIndex + delta));
    onEndDateChange(rows[newEndIndex - 1].date);
  }
  const windowTouchesOpenMonth = openMonthInfo !== null && window.some((r) => r.date >= openMonthInfo.month);
  const openMonthOrders = openMonthInfo
    ? rows
        .filter((r) => r.date >= openMonthInfo.month)
        .reduce((acc, r) => ({ placed: acc.placed + r.ordersPlaced, resolved: acc.resolved + r.ordersResolved }), {
          placed: 0,
          resolved: 0,
        })
    : null;

  const lines = buildLines(window, {
    flatFixedExpenses,
    monthly: false,
    perfHistory,
    zeroBeforeDate,
    expected: expectedDeliveryRate,
  });

  return (
    <div className="space-y-2">
      {windowTouchesOpenMonth && openMonthInfo && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fmtMonth(openMonthInfo.month)} is still settling - figures are projected using{" "}
          {openMonthInfo.sourceMonth ? fmtMonth(openMonthInfo.sourceMonth) : "the default"}&apos;s delivery rate (
          {(openMonthInfo.rate * 100).toFixed(1)}%), not yet real per-order outcomes.{" "}
          {openMonthOrders && openMonthOrders.placed > 0 && (
            <>
              {openMonthOrders.resolved}/{openMonthOrders.placed} orders resolved so far (
              {((openMonthOrders.resolved / openMonthOrders.placed) * 100).toFixed(1)}%).
            </>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-gray-500">
          {fmtDate(window[0].date)} – {fmtDate(window[window.length - 1].date)}
        </span>
        <button
          type="button"
          disabled={!canGoEarlier}
          onClick={() => shiftWindow(-1)}
          className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Earlier day"
        >
          ◀
        </button>
        <button
          type="button"
          disabled={!canGoLater}
          onClick={() => shiftWindow(1)}
          className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Later day"
        >
          ▶
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
              {window.map((r) => (
                <th key={r.date} className="px-4 py-2 text-right text-sm font-semibold text-gray-900">
                  {fmtDate(r.date)}
                </th>
              ))}
              <th className="border-l-2 border-l-gray-400 px-4 py-2 text-right text-sm font-semibold text-gray-900">Total</th>
            </tr>
          </thead>
          <tbody>
            {/* Keyed by index, not label: the Actual and Meta Dashboard blocks
                deliberately repeat ROAS / CPA / CPA Limit / Fixed Cost / Order. */}
            {lines.map((line, i) => (
              <LineRow key={i} line={line} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LineRow({ line }: { line: Line }) {
  const bg = line.band !== undefined ? "bg-gray-200" : "";
  const cellSizeClass = line.small ? "text-xs" : "text-sm";
  const cellStyle = line.small ? { color: BRAND_NAVY } : undefined;
  const borderTop = line.subtotal ? "border-t-2 border-t-gray-400" : "";
  const totalDivider = "border-l-2 border-l-gray-400";

  // Ratio (Delivered / Orders) totals as delivered-sum/received-sum, not a sum of
  // daily ratios; percent and decimal lines use the caller-supplied total (a true
  // rate over the window, never an average of the columns'); everything else is a
  // plain sum of the daily values.
  const total =
    line.kind === "ratio"
      ? sum(line.values)
      : line.kind === "percent" || line.kind === "decimal"
        ? line.total ?? 0
        : line.total ?? sum(line.values);
  const totalDenominator = line.kind === "ratio" ? sum(line.ratioTotals!) : undefined;

  return (
    <>
      {line.blankBefore && (
        <tr>
          <td className="h-3" colSpan={line.values.length + 2} />
        </tr>
      )}
      <tr className={bg}>
        <td
          className={`${borderTop} px-2 py-1.5 ${cellSizeClass} ${line.bold ? "font-bold text-gray-900" : "text-gray-700"}`}
          style={cellStyle}
        >
          {line.label}
        </td>
        {line.values.map((v, i) => {
          const negative = line.subtotal && v < 0;
          const valueColor = negative ? "text-red-700" : "text-gray-900";
          return (
            <td
              key={i}
              className={`${borderTop} px-4 py-1.5 text-right ${cellSizeClass} ${
                line.bold ? `font-bold ${valueColor}` : valueColor
              }`}
              style={cellStyle}
            >
              {line.kind === "header"
                ? ""
                : line.kind === "decimal"
                  ? v.toFixed(2)
                  : line.kind === "percent"
                    ? `${v.toFixed(0)}%`
                    : line.kind === "ratio"
                      ? `${v}/${line.ratioTotals![i]}`
                      : line.kind === "count"
                        ? v
                        : fmtMoney(v)}
            </td>
          );
        })}
        {(() => {
          const negative = line.subtotal && total < 0;
          const valueColor = negative ? "text-red-700" : "text-gray-900";
          return (
            <td
              className={`${borderTop} ${totalDivider} px-4 py-1.5 text-right ${cellSizeClass} ${
                line.bold ? `font-bold ${valueColor}` : valueColor
              }`}
              style={cellStyle}
            >
              {line.kind === "header"
                ? ""
                : line.kind === "decimal"
                  ? total.toFixed(2)
                  : line.kind === "percent"
                    ? `${total.toFixed(0)}%`
                    : line.kind === "ratio"
                      ? `${total}/${totalDenominator}`
                      : line.kind === "count"
                        ? total
                        : fmtMoney(total)}
            </td>
          );
        })()}
      </tr>
    </>
  );
}
