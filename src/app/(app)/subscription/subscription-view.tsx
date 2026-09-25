"use client";

import { Fragment, useMemo, useState } from "react";
import {
  DUE_SOON_DAYS,
  GRACE_DAYS,
  STATUS_LABELS,
  type Subscriber,
  type SubscriptionDashboard,
  type SubscriptionMonth,
  type SubscriptionStatus,
} from "@/lib/subscriptions/shared";

const STATUS_ORDER: SubscriptionStatus[] = ["overdue", "late", "due_soon", "active"];

const STATUS_BADGE: Record<SubscriptionStatus, string> = {
  active: "bg-green-50 text-green-700 ring-green-200",
  due_soon: "bg-amber-50 text-amber-700 ring-amber-200",
  late: "bg-orange-50 text-orange-700 ring-orange-200",
  overdue: "bg-red-50 text-red-700 ring-red-200",
};

function money(n: number): string {
  return `EGP ${Math.round(n).toLocaleString("en-US")}`;
}

function fmtDate(day: string): string {
  return new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function renewalHint(days: number): string {
  if (days === 0) return "today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  return `${-days} day${days === -1 ? "" : "s"} late`;
}

// Per-column filters, one control under each header. Empty = no filter.
type Filters = {
  name: string;
  phone: string;
  since: string; // "YYYY-MM"
  months: string; // "1", "2", ... or "3+"
  lastOrder: string; // order number or date text
  renewal: "" | "past" | "7" | "30" | "later";
  status: SubscriptionStatus | "";
  minRevenue: string;
};

const NO_FILTERS: Filters = { name: "", phone: "", since: "", months: "", lastOrder: "", renewal: "", status: "", minRevenue: "" };

type SortKey = "name" | "phone" | "since" | "months" | "lastOrder" | "renewal" | "status" | "revenue";

const SORT_VALUE: Record<SortKey, (s: Subscriber) => string | number> = {
  name: (s) => (s.name ?? "").toLowerCase(),
  phone: (s) => s.phone ?? "",
  since: (s) => s.since,
  months: (s) => s.monthsPaid,
  lastOrder: (s) => s.lastOrder.day,
  renewal: (s) => s.daysToRenewal,
  status: (s) => STATUS_ORDER.indexOf(s.status),
  revenue: (s) => s.revenue,
};

function fmtMonth(month: string): string {
  return new Date(month + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

function matches(s: Subscriber, f: Filters): boolean {
  const has = (value: string | null, q: string) => !q || (value ?? "").toLowerCase().includes(q.trim().toLowerCase());
  if (!has(s.name, f.name)) return false;
  if (f.phone && !(s.phone ?? "").replace(/\s/g, "").includes(f.phone.replace(/\s/g, ""))) return false;
  if (f.since && s.since.slice(0, 7) !== f.since) return false;
  if (f.months === "3+" ? s.monthsPaid < 3 : f.months && s.monthsPaid !== Number(f.months)) return false;
  if (f.lastOrder) {
    const q = f.lastOrder.trim().toLowerCase().replace(/^#/, "");
    if (!s.lastOrder.orderNumber.toLowerCase().includes(q) && !fmtDate(s.lastOrder.day).toLowerCase().includes(q)) return false;
  }
  if (f.renewal === "past" && s.daysToRenewal >= 0) return false;
  if (f.renewal === "7" && (s.daysToRenewal < 0 || s.daysToRenewal > 7)) return false;
  if (f.renewal === "30" && (s.daysToRenewal < 0 || s.daysToRenewal > 30)) return false;
  if (f.renewal === "later" && s.daysToRenewal <= 30) return false;
  if (f.status && s.status !== f.status) return false;
  if (f.minRevenue && s.revenue < Number(f.minRevenue)) return false;
  return true;
}

export function SubscriptionView({ dashboard }: { dashboard: SubscriptionDashboard }) {
  const { subscribers, totals } = dashboard;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // Default order is the server's: most urgent renewal first.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const active = Object.values(filters).some((v) => v !== "");

  const counts = useMemo(() => {
    const c: Record<SubscriptionStatus, number> = { active: 0, due_soon: 0, late: 0, overdue: 0 };
    for (const s of subscribers) c[s.status]++;
    return c;
  }, [subscribers]);

  const sinceMonths = useMemo(() => [...new Set(subscribers.map((s) => s.since.slice(0, 7)))].sort().reverse(), [subscribers]);
  const monthOptions = useMemo(() => {
    const exact = [...new Set(subscribers.map((s) => s.monthsPaid))].filter((m) => m < 3).sort((x, y) => x - y);
    return [...exact.map(String), ...(subscribers.some((s) => s.monthsPaid >= 3) ? ["3+"] : [])];
  }, [subscribers]);

  const shown = useMemo(() => {
    const list = subscribers.filter((s) => matches(s, filters));
    if (!sort) return list;
    const value = SORT_VALUE[sort.key];
    return [...list].sort((x, y) => {
      const a = value(x);
      const b = value(y);
      return (a < b ? -1 : a > b ? 1 : 0) * sort.dir;
    });
  }, [subscribers, filters, sort]);

  function toggleSort(key: SortKey) {
    setSort((cur) => (cur?.key !== key ? { key, dir: 1 } : cur.dir === 1 ? { key, dir: -1 } : null));
  }

  const header = (key: SortKey, label: string, right = false) => (
    <th className={`px-3 py-2 ${right ? "text-right" : ""}`}>
      <button type="button" onClick={() => toggleSort(key)} className="uppercase hover:text-gray-900" title="Sort">
        {label}
        <span className="ml-1 text-gray-400">{sort?.key === key ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
  const input = "w-full min-w-0 rounded border border-gray-300 bg-white px-1.5 py-1 text-xs font-normal normal-case text-gray-700";

  return (
    <div className="space-y-6">
      <MonthlyPnl months={dashboard.months} customers={totals.customers} active={totals.active} />

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip active={filters.status === ""} onClick={() => set("status", "")} label={`All ${subscribers.length}`} />
          {STATUS_ORDER.map((st) => (
            <FilterChip
              key={st}
              active={filters.status === st}
              onClick={() => set("status", st)}
              label={`${STATUS_LABELS[st]} ${counts[st]}`}
            />
          ))}
          {active && (
            <button type="button" onClick={() => setFilters(NO_FILTERS)} className="ml-auto text-xs text-gray-500 hover:text-gray-900">
              Clear filters
            </button>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                {header("name", "Customer")}
                {header("phone", "Phone")}
                {header("since", "Since")}
                {header("months", "Months paid", true)}
                {header("lastOrder", "Last order")}
                {header("renewal", "Next renewal")}
                {header("status", "Status")}
                {header("revenue", "Revenue", true)}
              </tr>
              <tr className="border-t border-gray-200">
                <th className="px-2 pb-2">
                  <input className={input} value={filters.name} onChange={(e) => set("name", e.target.value)} placeholder="Name" />
                </th>
                <th className="px-2 pb-2">
                  <input className={input} value={filters.phone} onChange={(e) => set("phone", e.target.value)} placeholder="Phone" />
                </th>
                <th className="px-2 pb-2">
                  <select className={input} value={filters.since} onChange={(e) => set("since", e.target.value)}>
                    <option value="">Any</option>
                    {sinceMonths.map((m) => (
                      <option key={m} value={m}>
                        {fmtMonth(m)}
                      </option>
                    ))}
                  </select>
                </th>
                <th className="px-2 pb-2">
                  <select className={input} value={filters.months} onChange={(e) => set("months", e.target.value)}>
                    <option value="">Any</option>
                    {monthOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </th>
                <th className="px-2 pb-2">
                  <input
                    className={input}
                    value={filters.lastOrder}
                    onChange={(e) => set("lastOrder", e.target.value)}
                    placeholder="Order # or date"
                  />
                </th>
                <th className="px-2 pb-2">
                  <select className={input} value={filters.renewal} onChange={(e) => set("renewal", e.target.value as Filters["renewal"])}>
                    <option value="">Any</option>
                    <option value="past">Past due</option>
                    <option value="7">Next 7 days</option>
                    <option value="30">Next 30 days</option>
                    <option value="later">Later than 30 days</option>
                  </select>
                </th>
                <th className="px-2 pb-2">
                  <select className={input} value={filters.status} onChange={(e) => set("status", e.target.value as Filters["status"])}>
                    <option value="">Any</option>
                    {STATUS_ORDER.map((st) => (
                      <option key={st} value={st}>
                        {STATUS_LABELS[st]}
                      </option>
                    ))}
                  </select>
                </th>
                <th className="px-2 pb-2">
                  <input
                    className={`${input} text-right`}
                    type="number"
                    min="0"
                    value={filters.minRevenue}
                    onChange={(e) => set("minRevenue", e.target.value)}
                    placeholder="Min EGP"
                  />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.map((sub) => (
                <Row key={sub.key} s={sub} open={open === sub.key} onToggle={() => setOpen(open === sub.key ? null : sub.key)} />
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-gray-400">
                    {subscribers.length === 0 ? "No subscription orders yet." : "No customers match."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-400">
          {shown.length} of {subscribers.length} customers shown. Click a column name to sort by it. Next renewal = 1 month after
          the customer&apos;s last subscription order. <strong>Due soon</strong> = renewal within {DUE_SOON_DAYS} days;{" "}
          <strong>Late</strong> = up to {GRACE_DAYS} days past it; <strong>Overdue</strong> = more than {GRACE_DAYS} days past it
          with no new order. Cancelled or returned orders don&apos;t count as a paid month. Revenue counts the subscription
          product only. Click a customer to see their orders.
        </p>
      </div>
    </div>
  );
}

function Row({ s, open, onToggle }: { s: Subscriber; open: boolean; onToggle: () => void }) {
  return (
    <Fragment>
      <tr className="cursor-pointer text-gray-700 hover:bg-gray-50" onClick={onToggle}>
        <td className="px-3 py-2 font-medium text-gray-900">
          <span className="mr-1 inline-block w-3 text-gray-400">{open ? "▾" : "▸"}</span>
          {s.name ?? <span className="text-gray-400">Unknown</span>}
        </td>
        <td className="px-3 py-2 tabular-nums">
          {s.phone ? (
            <a href={`tel:${s.phone}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
              {s.phone}
            </a>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">{fmtDate(s.since)}</td>
        <td className="px-3 py-2 text-right font-semibold tabular-nums text-gray-900">{s.monthsPaid}</td>
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="font-mono text-xs">{s.lastOrder.orderNumber}</span>{" "}
          <span className="text-gray-500">{fmtDate(s.lastOrder.day)}</span>
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          {fmtDate(s.nextRenewal)} <span className="text-xs text-gray-400">({renewalHint(s.daysToRenewal)})</span>
        </td>
        <td className="px-3 py-2">
          <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STATUS_BADGE[s.status]}`}>
            {STATUS_LABELS[s.status]}
          </span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{money(s.revenue)}</td>
      </tr>
      {open && (
        <tr className="bg-gray-50/70">
          <td colSpan={8} className="px-3 py-2 pl-9">
            <table className="text-xs">
              <thead className="text-gray-400">
                <tr>
                  <th className="pr-6 text-left font-medium">Order</th>
                  <th className="pr-6 text-left font-medium">Date</th>
                  <th className="pr-6 text-right font-medium">Revenue</th>
                  <th className="text-right font-medium">COGS</th>
                </tr>
              </thead>
              <tbody className="text-gray-700">
                {s.orders.map((o) => (
                  <tr key={o.orderNumber}>
                    <td className="pr-6 font-mono">{o.orderNumber}</td>
                    <td className="pr-6">{fmtDate(o.day)}</td>
                    <td className="pr-6 text-right tabular-nums">{money(o.revenue)}</td>
                    <td className="text-right tabular-nums">{money(o.cogs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium ${
        active ? "bg-gray-900 text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
  );
}

// How many months the P&L shows at once; ◀ ▶ move the window a month at a time.
const PNL_WINDOW = 6;

function fmtNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtMonthCol(month: string): string {
  return new Date(month + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

// The subscription's own P&L month by month, laid out like the product
// Rollforward (Analysis by Product): one column per month, ◀ ▶ to move through
// them, then Total and Avg/month for the months on screen.
function MonthlyPnl({ months, customers, active }: { months: SubscriptionMonth[]; customers: number; active: number }) {
  // Index of the last month on screen; starts on the current month.
  const [end, setEnd] = useState(months.length - 1);
  const shown = months.slice(Math.max(0, end - PNL_WINDOW + 1), end + 1);

  const cols = shown.map((m) => {
    const grossProfit = m.revenue - m.cogs;
    const contribution = grossProfit - m.marketing;
    return { ...m, grossProfit, contribution };
  });
  const sum = (f: (c: (typeof cols)[number]) => number) => cols.reduce((a, c) => a + f(c), 0);
  const total = {
    orders: sum((c) => c.orders),
    revenue: sum((c) => c.revenue),
    cogs: sum((c) => c.cogs),
    grossProfit: sum((c) => c.grossProfit),
    marketing: sum((c) => c.marketing),
    contribution: sum((c) => c.contribution),
  };
  const margin = (profit: number, revenue: number) => (revenue ? (profit / revenue) * 100 : NaN);

  const lines: { label: string; vals: number[]; total: number; pct?: boolean; profit?: boolean; bold?: boolean; small?: boolean }[] = [
    { label: "Orders", vals: cols.map((c) => c.orders), total: total.orders, small: true },
    { label: "Rev", vals: cols.map((c) => c.revenue), total: total.revenue },
    { label: "COGS", vals: cols.map((c) => c.cogs), total: total.cogs },
    { label: "Gross Profit", vals: cols.map((c) => c.grossProfit), total: total.grossProfit, profit: true, bold: true },
    {
      label: "Gross Margin",
      vals: cols.map((c) => margin(c.grossProfit, c.revenue)),
      total: margin(total.grossProfit, total.revenue),
      pct: true,
    },
    { label: "Marketing Spend", vals: cols.map((c) => c.marketing), total: total.marketing },
    { label: "Contribution Profit", vals: cols.map((c) => c.contribution), total: total.contribution, profit: true, bold: true },
    {
      label: "Contribution Margin",
      vals: cols.map((c) => margin(c.contribution, c.revenue)),
      total: margin(total.contribution, total.revenue),
      pct: true,
    },
  ];

  const cellText = (v: number, pct?: boolean) => (pct ? (Number.isNaN(v) ? "—" : `${v.toFixed(1)}%`) : fmtNum(v));
  const colorCls = (v: number, profit?: boolean) => (profit ? (v >= 0 ? "text-green-700" : "text-red-700") : "text-gray-900");
  const arrow =
    "flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900">
          Subscription P&amp;L
          <span className="ml-1.5 font-normal text-gray-400">
            ({customers} customer{customers === 1 ? "" : "s"} · {active} active)
          </span>
        </span>
        <div className="flex items-center gap-2">
          {shown.length > 0 && (
            <span className="text-xs text-gray-500">
              {fmtMonthCol(shown[0].month)} – {fmtMonthCol(shown[shown.length - 1].month)}
            </span>
          )}
          <button type="button" disabled={end - PNL_WINDOW + 1 <= 0} onClick={() => setEnd(end - 1)} className={arrow} aria-label="Earlier month">
            ◀
          </button>
          <button type="button" disabled={end >= months.length - 1} onClick={() => setEnd(end + 1)} className={arrow} aria-label="Later month">
            ▶
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
              {cols.map((c) => (
                <th key={c.month} className="px-3 py-2 text-right text-sm font-semibold text-gray-900">
                  {fmtMonthCol(c.month)}
                </th>
              ))}
              <th className="border-l-2 border-l-gray-400 px-3 py-2 text-right text-sm font-semibold text-gray-900">Total</th>
              <th className="px-3 py-2 text-right text-sm font-semibold text-gray-900">Avg/month</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              // Money lines average per month; a margin's only sensible "average"
              // is the margin over the whole window.
              const avg = line.pct ? line.total : line.total / (cols.length || 1);
              return (
                <tr key={line.label} className={`${line.bold ? "bg-gray-50" : ""}${line.small ? " text-xs" : ""}`}>
                  <td className={`px-2 py-1.5 ${line.small ? "text-gray-500" : line.bold ? "font-bold text-gray-900" : "text-gray-700"}`}>
                    {line.label}
                  </td>
                  {line.vals.map((v, i) => (
                    <td key={i} className={`px-3 py-1.5 text-right tabular-nums ${line.bold ? "font-bold " : ""}${colorCls(v, line.profit)}`}>
                      {cellText(v, line.pct)}
                    </td>
                  ))}
                  <td
                    className={`border-l-2 border-l-gray-400 px-3 py-1.5 text-right tabular-nums ${line.bold ? "font-bold " : ""}${colorCls(
                      line.total,
                      line.profit
                    )}`}
                  >
                    {cellText(line.total, line.pct)}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${line.bold ? "font-bold " : ""}${colorCls(avg, line.profit)}`}>
                    {cellText(avg, line.pct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400">
        Months are by order date. Marketing Spend = ads charged to the Subscription product that month, split exactly as in
        Analysis by Product → Rollforward. Margins are % of revenue.
      </p>
    </div>
  );
}
