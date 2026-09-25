"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { egyptToday } from "@/lib/dates";
import {
  COMPONENT_TYPES,
  COMPONENT_TYPE_LABELS,
  COMPONENT_UNIT_LABELS,
  COMPONENT_UNITS,
  type ComponentType,
  type ComponentUnit,
} from "@/lib/products/component-types";
import type { InventoryItem, InventoryItemRow, InventoryLedger, InventoryMovement } from "@/lib/inventory/inventory";

// Months on screen at once; the arrows move the window a month at a time.
const WINDOW = 6;
const NO_MOVEMENT: InventoryMovement = { purchases: 0, returns: 0, orders: 0, adjustments: 0 };

// Months are keyed by their first day, "YYYY-MM-01".
function monthOf(day: string): string {
  return day.slice(0, 7) + "-01";
}

function addMonths(month: string, n: number): string {
  const d = new Date(month + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

function lastDayOf(month: string): string {
  const d = new Date(addMonths(month, 1) + "T00:00:00Z");
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function windowMonths(end: string): string[] {
  const out: string[] = [];
  for (let i = WINDOW - 1; i >= 0; i--) out.push(addMonths(end, -i));
  return out;
}

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function fmtMonth(month: string): string {
  return new Date(month + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// A line's movements summed per month. The server sends them per day (sparse);
// the ledger only ever shows months now.
function movementsForMonth(row: InventoryItemRow, month: string): InventoryMovement {
  const total = { ...NO_MOVEMENT };
  for (const [d, m] of Object.entries(row.days)) {
    if (monthOf(d) !== month) continue;
    total.purchases += m.purchases;
    total.returns += m.returns;
    total.orders += m.orders;
    total.adjustments += m.adjustments;
  }
  return total;
}

// Pieces are whole things; KG and L carry decimals.
function fmtQty(n: number, unit: ComponentUnit): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: unit === "pcs" ? 0 : 2 });
}

// The balance a line opens the window on: its counted opening balance plus every
// movement dated before the window starts. Movements only ever exist on or after
// the ledger's start date, so no lower bound is needed here.
function balanceBefore(row: InventoryItemRow, day: string): number {
  let bal = row.opening;
  for (const [d, m] of Object.entries(row.days)) {
    if (d >= day) continue;
    bal += m.purchases + m.returns - m.orders + m.adjustments;
  }
  return bal;
}

type Screen = "ledger" | "opening" | "groups";

// `canEdit` is Purchasing → Inventory's edit right. Without it the ledger is a
// read-only report: the Adjustments cells print instead of accepting input, and
// the two write screens (groups, opening balances) are gone.
// The API enforces the same thing, so hiding them is only about not offering
// buttons that would come back 403.
export function InventoryTab({ openingRows, canEdit }: { openingRows: InventoryItem[]; canEdit: boolean }) {
  const [ledger, setLedger] = useState<InventoryLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The last month on screen - starts on the current month.
  const [windowEnd, setWindowEnd] = useState(monthOf(egyptToday()));
  const [screen, setScreen] = useState<Screen>("ledger");
  // Bumped after a save, to re-run the fetch below.
  const [reloadKey, setReloadKey] = useState(0);
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/inventory");
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to load inventory");
        if (cancelled) return;
        setLedger(data.ledger as InventoryLedger);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load inventory");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Never before the month the ledger opened in - there is nothing to show there.
  const ledgerStart = ledger?.startDate ?? null;
  const months = useMemo(
    () => windowMonths(windowEnd).filter((m) => !ledgerStart || m >= monthOf(ledgerStart)),
    [windowEnd, ledgerStart]
  );

  function afterSave() {
    setScreen("ledger");
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  // An edited Adjustments cell (one figure per month). The new figure is written
  // into the local ledger straight away - replacing whatever that month held, as
  // the server does, on the month's last day - so the balances move with it; then
  // a silent refetch confirms what was stored.
  async function saveAdjustment(row: InventoryItemRow, month: string, quantity: number): Promise<string | null> {
    try {
      const res = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adjustment: { kind: row.kind, id: row.id, month: month.slice(0, 7), quantity } }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save adjustment");
      setLedger((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((r) => {
                if (r.key !== row.key) return r;
                const days: InventoryItemRow["days"] = {};
                for (const [d, m] of Object.entries(r.days)) {
                  days[d] = monthOf(d) === month ? { ...m, adjustments: 0 } : m;
                }
                const anchor = lastDayOf(month);
                days[anchor] = { ...(days[anchor] ?? NO_MOVEMENT), adjustments: quantity };
                return { ...r, days };
              }),
            }
          : prev
      );
      setAdjustmentError(null);
      setReloadKey((k) => k + 1);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save adjustment";
      setAdjustmentError(message);
      return message;
    }
  }

  if (loading) return <p className="py-10 text-center text-sm text-gray-400">Loading inventory…</p>;
  if (error) return <p className="py-10 text-center text-sm text-red-600">{error}</p>;

  const startDate = ledger?.startDate ?? null;
  const today = ledger?.today ?? egyptToday();

  if (canEdit && screen === "groups") return <GroupsEditor onDone={afterSave} onCancel={() => setScreen("ledger")} />;

  // Nothing to show until the owner sets the start date and counts the stock -
  // and opening the ledger isn't the same right as opening it up.
  if (!startDate || screen === "opening") {
    if (!canEdit) {
      return (
        <p className="py-10 text-center text-sm text-gray-400">
          The inventory ledger hasn&apos;t been opened yet — an owner needs to set the start date and count the stock.
        </p>
      );
    }
    return (
      <OpeningBalancesForm
        rows={openingRows}
        startDate={startDate}
        onSaved={afterSave}
        onCancel={startDate ? () => setScreen("ledger") : undefined}
      />
    );
  }

  const rows = ledger?.rows ?? [];
  const byType = new Map<ComponentType, InventoryItemRow[]>();
  for (const r of rows) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  const canPrev = months[0] > monthOf(startDate);
  const canNext = windowEnd < monthOf(today);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-400">
          Opened {fmtDate(startDate)}. Counted per whole product: additions = purchases + courier returns, deductions =
          orders handed to the courier; adjustments are typed in per month (+ found / − lost).
          Quantities in KG / L / Pcs.
        </p>
        <div className="flex items-center gap-2 text-sm">
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => setScreen("groups")}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
              >
                Groups
              </button>
              <button
                type="button"
                onClick={() => setScreen("opening")}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
              >
                Opening balances
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setWindowEnd(addMonths(windowEnd, -1))}
            disabled={!canPrev}
            className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
            aria-label="Previous month"
          >
            ←
          </button>
          <span className="min-w-[9rem] text-center text-xs text-gray-500">
            {fmtMonth(months[0])} – {fmtMonth(windowEnd)}
          </span>
          <button
            type="button"
            onClick={() => setWindowEnd(addMonths(windowEnd, 1))}
            disabled={!canNext}
            className="rounded border border-gray-300 px-2 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-30"
            aria-label="Next month"
          >
            →
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">Item</th>
              {months.map((m) => (
                <th key={m} className="px-3 py-2 text-right">
                  {fmtMonth(m)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {COMPONENT_TYPES.filter((t) => (byType.get(t)?.length ?? 0) > 0).map((t) => (
              <TypeGroup
                key={t}
                type={t}
                rows={byType.get(t)!}
                months={months}
                startDate={startDate}
                canEdit={canEdit}
                onSaveAdjustment={saveAdjustment}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={months.length + 1} className="px-3 py-4 text-center text-gray-400">
                  No components yet — add them in Products → Product Components.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {adjustmentError && <p className="text-sm text-red-600">{adjustmentError}</p>}
    </div>
  );
}

type SaveAdjustment = (row: InventoryItemRow, month: string, quantity: number) => Promise<string | null>;

function TypeGroup({
  type,
  rows,
  months,
  startDate,
  canEdit,
  onSaveAdjustment,
}: {
  type: ComponentType;
  rows: InventoryItemRow[];
  months: string[];
  startDate: string;
  canEdit: boolean;
  onSaveAdjustment: SaveAdjustment;
}) {
  return (
    <>
      <tr className="bg-gray-50/70">
        <td colSpan={months.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {COMPONENT_TYPE_LABELS[type]}
        </td>
      </tr>
      {rows.map((r) => (
        <ItemBlock
          key={r.key}
          row={r}
          months={months}
          startDate={startDate}
          canEdit={canEdit}
          onSaveAdjustment={onSaveAdjustment}
        />
      ))}
    </>
  );
}

// One ledger line = a header plus the movement rows, month by month. The balance
// is carried across the window client-side: each month's ending is the next
// month's beginning.
function ItemBlock({
  row,
  months,
  startDate,
  canEdit,
  onSaveAdjustment,
}: {
  row: InventoryItemRow;
  months: string[];
  startDate: string;
  canEdit: boolean;
  onSaveAdjustment: SaveAdjustment;
}) {
  const cells: (InventoryMovement & { begin: number; ending: number })[] = [];
  let running = balanceBefore(row, months[0]);
  for (const month of months) {
    const m = movementsForMonth(row, month);
    const ending = running + m.purchases + m.returns - m.orders + m.adjustments;
    cells.push({ begin: running, ending, ...m });
    running = ending;
  }

  const zero = (n: number) => (n === 0 ? <span className="text-gray-300">—</span> : fmtQty(n, row.unit));

  return (
    <>
      <tr className="border-t border-gray-200">
        <td colSpan={months.length + 1} className="px-3 pt-2 text-sm font-medium text-gray-900">
          {row.name} <span className="text-xs font-normal text-gray-400">({COMPONENT_UNIT_LABELS[row.unit]})</span>
          {/* A grouped line is counted as one thing, so say what is in it. */}
          {row.memberNames.length > 0 && (
            <span className="ml-2 text-xs font-normal text-gray-400" title={row.memberNames.join(", ")}>
              — {row.memberNames.length} components counted together
            </span>
          )}
        </td>
      </tr>
      <tr className="text-gray-500">
        <td className="py-1 pl-6 pr-3 text-xs">Beginning</td>
        {cells.map((c, i) => (
          <td key={i} className="px-3 py-1 text-right text-xs tabular-nums">
            {fmtQty(c.begin, row.unit)}
          </td>
        ))}
      </tr>
      <tr className="text-gray-600">
        <td className="py-1 pl-6 pr-3 text-xs">Additions — purchases</td>
        {cells.map((c, i) => (
          <td key={i} className="px-3 py-1 text-right text-xs tabular-nums text-emerald-700">
            {zero(c.purchases)}
          </td>
        ))}
      </tr>
      <tr className="text-gray-600">
        <td className="py-1 pl-6 pr-3 text-xs">Additions — returns</td>
        {cells.map((c, i) => (
          <td key={i} className="px-3 py-1 text-right text-xs tabular-nums text-emerald-700">
            {zero(c.returns)}
          </td>
        ))}
      </tr>
      <tr className="text-gray-600">
        <td className="py-1 pl-6 pr-3 text-xs">Deductions — orders</td>
        {cells.map((c, i) => (
          <td key={i} className="px-3 py-1 text-right text-xs tabular-nums text-red-600">
            {zero(c.orders)}
          </td>
        ))}
      </tr>
      {/* The only hand-typed line of the ledger: signed stock changes (breakage,
          samples, recount corrections), per month. Without the tab's edit right it
          reads like every other row above. */}
      <tr className="text-gray-600">
        <td className="py-1 pl-6 pr-3 text-xs">Adjustments</td>
        {months.map((month, i) =>
          canEdit ? (
            <td key={month} className="px-2 py-1 text-right">
              <AdjustmentCell
                value={cells[i].adjustments}
                unit={row.unit}
                disabled={lastDayOf(month) < startDate}
                onSave={(qty) => onSaveAdjustment(row, month, qty)}
              />
            </td>
          ) : (
            <td
              key={month}
              className={`px-3 py-1 text-right text-xs tabular-nums ${cells[i].adjustments < 0 ? "text-red-600" : "text-emerald-700"}`}
            >
              {zero(cells[i].adjustments)}
            </td>
          )
        )}
      </tr>
      <tr className="font-medium text-gray-900">
        <td className="py-1 pb-2 pl-6 pr-3 text-xs">Ending</td>
        {cells.map((c, i) => (
          <td key={i} className={`px-3 py-1 pb-2 text-right text-xs tabular-nums ${c.ending < 0 ? "text-red-600" : ""}`}>
            {fmtQty(c.ending, row.unit)}
          </td>
        ))}
      </tr>
    </>
  );
}

// One editable month of the Adjustments row: a signed figure (-2 = two broken,
// 5 = five found on a recount). It holds a draft while being typed and commits
// on blur or Enter; Escape puts the saved figure back. Months before the ledger
// opened are not editable - the server refuses them anyway.
function AdjustmentCell({
  value,
  unit,
  disabled,
  onSave,
}: {
  value: number;
  unit: ComponentUnit;
  disabled: boolean;
  onSave: (quantity: number) => Promise<string | null>;
}) {
  const saved = value === 0 ? "" : String(value);
  const [draft, setDraft] = useState(saved);
  const [shown, setShown] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // A silent refetch (or another edit) landed: show what is actually stored.
  if (shown !== saved) {
    setShown(saved);
    setDraft(saved);
  }

  async function commit() {
    const text = draft.trim();
    const quantity = text === "" ? 0 : Number(text);
    if (!Number.isFinite(quantity)) {
      setFailed("Enter a number (negative = stock lost)");
      return;
    }
    if (quantity === value) {
      setFailed(null);
      setDraft(quantity === 0 ? "" : String(quantity));
      return;
    }
    setSaving(true);
    const error = await onSave(quantity);
    setSaving(false);
    setFailed(error);
    if (error) setDraft(saved); // nothing was written - don't leave a figure that isn't there
  }

  if (disabled) {
    return <span className="block px-1 text-right text-xs text-gray-300">—</span>;
  }

  return (
    <input
      type="number"
      step="0.001"
      inputMode="decimal"
      value={draft}
      disabled={saving}
      title={failed ?? `Adjustment, + found / − lost (${COMPONENT_UNIT_LABELS[unit]})`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(saved);
          setFailed(null);
          e.currentTarget.blur();
        }
      }}
      placeholder="—"
      aria-label={`Adjustment (${COMPONENT_UNIT_LABELS[unit]})`}
      className={`w-20 rounded border px-1 py-0.5 text-right text-xs tabular-nums ${value < 0 ? "text-red-600" : "text-emerald-700"} placeholder:text-gray-300 focus:border-gray-400 focus:outline-none disabled:opacity-50 ${
        failed ? "border-red-400 bg-red-50" : "border-transparent hover:border-gray-300"
      }`}
    />
  );
}

// First-time setup (and later corrections): the day the ledger opens on, and the
// counted on-hand quantity of every line on that day.
function OpeningBalancesForm({
  rows,
  startDate,
  onSaved,
  onCancel,
}: {
  rows: InventoryItem[];
  startDate: string | null;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [date, setDate] = useState(startDate ?? egyptToday());
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.key, r.quantity ? String(r.quantity) : ""]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const balances = rows.map((r) => ({
        kind: r.kind,
        id: r.id,
        quantity: values[r.key] ? Number(values[r.key]) : 0,
      }));
      if (balances.some((b) => !Number.isFinite(b.quantity) || b.quantity < 0)) {
        throw new Error("Every quantity must be zero or a positive number.");
      }
      const res = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: date, balances }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const byType = new Map<ComponentType, InventoryItem[]>();
  for (const r of rows) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <label className="block text-xs font-medium text-gray-500">Inventory start date</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
        <p className="mt-2 text-xs text-gray-400">
          The day the ledger opens on. Purchases, returns and orders are counted from this day forward; anything shipped
          before it is ignored, including its later return.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">Item</th>
              <th className="px-3 py-2 text-left">Unit</th>
              <th className="px-3 py-2 text-right">Opening quantity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {COMPONENT_TYPES.filter((t) => (byType.get(t)?.length ?? 0) > 0).map((t) => (
              <Fragment key={t}>
                <tr className="bg-gray-50/70">
                  <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {COMPONENT_TYPE_LABELS[t]}
                  </td>
                </tr>
                {(byType.get(t) ?? []).map((r) => (
                  <tr key={r.key}>
                    <td className="px-3 py-1.5 text-gray-900">
                      {r.name}
                      {r.memberNames.length > 0 && (
                        <span className="ml-2 text-xs text-gray-400" title={r.memberNames.join(", ")}>
                          — {r.memberNames.length} components counted together
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-gray-500">{COMPONENT_UNIT_LABELS[r.unit]}</td>
                    <td className="px-3 py-1.5 text-right">
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={values[r.key] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [r.key]: e.target.value }))}
                        placeholder="0"
                        className="w-32 rounded border border-gray-300 px-2 py-1 text-right text-sm tabular-nums"
                      />
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-gray-400">
                  No components yet — add them in Products → Product Components.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving || rows.length === 0}
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save opening balances"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

type GroupingModel = {
  groups: { id: number; name: string; unit: ComponentUnit; componentIds: number[] }[];
  components: { id: number; name: string; type: ComponentType; unit: ComponentUnit; groupId: number | null }[];
};

// Which components are counted as one line of stock. Purely a counting view -
// the components stay separate for costing, purchasing and the BOM.
function GroupsEditor({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [model, setModel] = useState<GroupingModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<{ id: number | null; name: string; unit: ComponentUnit; ids: number[] } | null>(
    null
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/inventory?grouping=1");
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to load");
        if (!cancelled) setModel(data.grouping as GroupingModel);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function post(body: unknown) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      setEditing(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (error && !model) return <p className="py-10 text-center text-sm text-red-600">{error}</p>;
  if (!model) return <p className="py-10 text-center text-sm text-gray-400">Loading groups…</p>;

  // Only components of the group's unit can join it, and one that already
  // belongs elsewhere is off limits.
  const selectable = editing
    ? model.components.filter((c) => c.unit === editing.unit && (c.groupId === null || c.groupId === editing.id))
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-400">
          Components counted as one line of stock — the seven essential oil scents read as a single “Essential oil”
          balance. This is a counting view only: each component keeps its own cost, purchases and BOM.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditing({ id: null, name: "", unit: "l", ids: [] })}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            + New group
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-800"
          >
            Back to ledger
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="space-y-2">
        {model.groups.map((g) => (
          <div key={g.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-sm font-medium text-gray-900">{g.name}</span>
                <span className="ml-2 text-xs text-gray-400">
                  ({COMPONENT_UNIT_LABELS[g.unit]}) — {g.componentIds.length} components
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing({ id: g.id, name: g.name, unit: g.unit, ids: [...g.componentIds] })}
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => post({ deleteGroupId: g.id })}
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  Ungroup
                </button>
              </div>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {g.componentIds
                .map((id) => model.components.find((c) => c.id === id)?.name ?? `#${id}`)
                .join(", ")}
            </p>
          </div>
        ))}
        {model.groups.length === 0 && (
          <p className="rounded-lg border border-dashed border-gray-300 py-6 text-center text-sm text-gray-400">
            No groups — every component is counted on its own line.
          </p>
        )}
      </div>

      {editing && (
        <div className="space-y-3 rounded-lg border border-gray-300 bg-white p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] grow">
              <label className="block text-xs font-medium text-gray-500">Group name</label>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Essential oil"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500">Unit</label>
              <select
                value={editing.unit}
                // Switching unit invalidates the picked members, so they clear.
                onChange={(e) => setEditing({ ...editing, unit: e.target.value as ComponentUnit, ids: [] })}
                className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              >
                {COMPONENT_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {COMPONENT_UNIT_LABELS[u]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto rounded border border-gray-200">
            {selectable.map((c) => (
              <label key={c.id} className="flex items-center gap-2 border-b border-gray-100 px-3 py-1.5 text-sm last:border-0">
                <input
                  type="checkbox"
                  checked={editing.ids.includes(c.id)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      ids: e.target.checked ? [...editing.ids, c.id] : editing.ids.filter((x) => x !== c.id),
                    })
                  }
                />
                <span className="text-gray-700">{c.name}</span>
                <span className="text-xs text-gray-400">{COMPONENT_TYPE_LABELS[c.type]}</span>
              </label>
            ))}
            {selectable.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-gray-400">
                No ungrouped components measured in {COMPONENT_UNIT_LABELS[editing.unit]}.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                post({ group: { id: editing.id, name: editing.name, unit: editing.unit, componentIds: editing.ids } })
              }
              className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save group"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <button type="button" onClick={onCancel} className="text-xs text-gray-500 underline">
        Back without reloading
      </button>
    </div>
  );
}
