"use client";

import { useEffect, useMemo, useState } from "react";
import { egyptToday } from "@/lib/dates";
import {
  ALLOCATION_UNIT_LABELS,
  COMPONENT_TYPE_LABELS,
  COMPONENT_TYPES,
  type ComponentType,
} from "@/lib/products/component-types";
import type { ShipmentReport, ProductReportRow, ComponentReportRow } from "@/lib/purchases/shipment-report";

const WINDOW = 7;

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function windowDays(end: string): string[] {
  const out: string[] = [];
  for (let i = WINDOW - 1; i >= 0; i--) out.push(addDays(end, -i));
  return out;
}

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function dayCount(row: { days: Record<string, { count: number }> }, day: string): number {
  return row.days[day]?.count ?? 0;
}

function windowTotal(row: { days: Record<string, { count: number }> }, days: string[]): number {
  return days.reduce((s, d) => s + dayCount(row, d), 0);
}

export function PurchasingReport() {
  const [report, setReport] = useState<ShipmentReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowEnd, setWindowEnd] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/purchases/report");
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to load report");
        if (cancelled) return;
        const r: ShipmentReport = data.report;
        setReport(r);
        setWindowEnd(r.maxDay ?? egyptToday());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const days = useMemo(() => (windowEnd ? windowDays(windowEnd) : []), [windowEnd]);

  if (loading) return <p className="py-10 text-center text-sm text-gray-400">Loading report… (scanning shipped orders)</p>;
  if (error) return <p className="py-10 text-center text-sm text-red-600">{error}</p>;
  if (!report || !windowEnd) return <p className="py-10 text-center text-sm text-gray-400">No shipped orders yet.</p>;

  const maxEnd = report.maxDay ?? egyptToday();
  const windowStart = days[0];
  const canPrev = report.minDay !== null && windowStart > report.minDay;
  const canNext = windowEnd < maxEnd;

  return (
    <div className="space-y-5">
      {/* Window navigation */}
      <div className="flex items-center justify-end gap-2 text-sm">
        <button
          type="button"
          onClick={() => setWindowEnd(addDays(windowEnd, -WINDOW))}
          disabled={!canPrev}
          className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
          aria-label="Previous week"
        >
          ←
        </button>
        <span className="min-w-[9rem] text-center text-xs text-gray-500">
          {fmtDate(windowStart)} – {fmtDate(windowEnd)}
        </span>
        <button
          type="button"
          onClick={() => setWindowEnd(addDays(windowEnd, WINDOW) > maxEnd ? maxEnd : addDays(windowEnd, WINDOW))}
          disabled={!canNext}
          className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
          aria-label="Next week"
        >
          →
        </button>
      </div>

      <ProductsTable rows={report.products} days={days} />
      <ComponentsTable rows={report.components} days={days} />
    </div>
  );
}

// ---- Table 1: final products (units shipped) ----
function ProductsTable({ rows, days }: { rows: ProductReportRow[]; days: string[] }) {
  const visible = rows.filter((r) => days.some((d) => dayCount(r, d) > 0));
  const colTotals = days.map((d) => visible.reduce((s, r) => s + dayCount(r, d), 0));
  const grand = colTotals.reduce((s, n) => s + n, 0);

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-gray-900">
        Final products <span className="font-normal text-gray-400">— units shipped</span>
      </h3>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">Product</th>
              {days.map((d) => (
                <th key={d} className="px-3 py-2 text-right">{fmtDate(d)}</th>
              ))}
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map((r) => (
              <tr key={r.id} className="text-gray-700">
                <td className="px-3 py-1.5 text-gray-900">{r.name}</td>
                {days.map((d) => (
                  <td key={d} className="px-3 py-1.5 text-right tabular-nums">
                    {dayCount(r, d) > 0 ? fmtCount(dayCount(r, d)) : <span className="text-gray-300">—</span>}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-medium tabular-nums text-gray-900">{fmtCount(windowTotal(r, days))}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={days.length + 2} className="px-3 py-4 text-center text-gray-400">
                  No products shipped in this window.
                </td>
              </tr>
            )}
          </tbody>
          {visible.length > 0 && (
            <tfoot className="border-t border-gray-200 bg-gray-50 font-medium text-gray-900">
              <tr>
                <td className="px-3 py-2 text-left">Total</td>
                {colTotals.map((t, i) => (
                  <td key={i} className="px-3 py-2 text-right tabular-nums">{fmtCount(t)}</td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">{fmtCount(grand)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ---- Table 2: components (quantity used, grouped by type) ----
function ComponentsTable({ rows, days }: { rows: ComponentReportRow[]; days: string[] }) {
  const visible = rows.filter((r) => days.some((d) => dayCount(r, d) > 0));

  const byType = new Map<ComponentType, ComponentReportRow[]>();
  for (const r of visible) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-gray-900">
        Components <span className="font-normal text-gray-400">— quantity used (g / ml / pc)</span>
      </h3>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">Component</th>
              {days.map((d) => (
                <th key={d} className="px-3 py-2 text-right">{fmtDate(d)}</th>
              ))}
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {COMPONENT_TYPES.filter((t) => (byType.get(t)?.length ?? 0) > 0).map((t) => (
              <ComponentTypeGroup key={t} type={t} rows={byType.get(t)!} days={days} />
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={days.length + 2} className="px-3 py-4 text-center text-gray-400">
                  No components used in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComponentTypeGroup({ type, rows, days }: { type: ComponentType; rows: ComponentReportRow[]; days: string[] }) {
  return (
    <>
      <tr className="bg-gray-50/60">
        <td colSpan={days.length + 2} className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
          {COMPONENT_TYPE_LABELS[type]}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.id} className="text-gray-700">
          <td className="px-3 py-1.5 text-gray-900">
            {r.name} <span className="text-xs text-gray-400">({ALLOCATION_UNIT_LABELS[r.unit]})</span>
          </td>
          {days.map((d) => (
            <td key={d} className="px-3 py-1.5 text-right tabular-nums">
              {dayCount(r, d) > 0 ? fmtCount(dayCount(r, d)) : <span className="text-gray-300">—</span>}
            </td>
          ))}
          <td className="px-3 py-1.5 text-right font-medium tabular-nums text-gray-900">{fmtCount(windowTotal(r, days))}</td>
        </tr>
      ))}
    </>
  );
}
