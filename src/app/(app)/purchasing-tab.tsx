"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { egyptToday } from "@/lib/dates";
import { COMPONENT_TYPES, COMPONENT_TYPE_LABELS, COMPONENT_UNIT_LABELS } from "@/lib/products/component-types";
import type { PurchaseComponentOption, PurchaseRecord } from "@/lib/purchases/purchases";

// A new cost this much above the current one triggers a confirm dialog.
const INCREASE_THRESHOLD = 0.2;

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function PurchasingTab({
  components,
  initialPurchases,
}: {
  components: PurchaseComponentOption[];
  initialPurchases: PurchaseRecord[];
}) {
  const router = useRouter();

  const [date, setDate] = useState(egyptToday());
  const [componentId, setComponentId] = useState<number | "">(components[0]?.id ?? "");
  const [quantity, setQuantity] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When set, the 20%+ confirm dialog is shown before saving.
  const [confirmIncrease, setConfirmIncrease] = useState<{ pct: number; current: number; newCost: number } | null>(null);

  const selected = useMemo(() => components.find((c) => c.id === componentId) ?? null, [components, componentId]);

  // Components grouped by type for the dropdown (raw material / package / …).
  const byType = useMemo(() => {
    const map = new Map<string, PurchaseComponentOption[]>();
    for (const c of components) {
      const list = map.get(c.type) ?? [];
      list.push(c);
      map.set(c.type, list);
    }
    return map;
  }, [components]);

  async function save() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ componentId, date, quantity: Number(quantity), amount: Number(amount), description }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      setQuantity("");
      setAmount("");
      setDescription("");
      setConfirmIncrease(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!componentId) {
      setError("Pick a component.");
      return;
    }
    const amt = Number(amount);
    const qty = Number(quantity);
    if (!Number.isFinite(amt) || amt < 0) {
      setError("Enter a valid amount.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Enter a valid quantity.");
      return;
    }
    const current = selected?.currentCost ?? null;
    // Only warn on a real increase of 20%+ over a known current cost.
    if (current !== null && current > 0 && amt >= current * (1 + INCREASE_THRESHOLD)) {
      setConfirmIncrease({ pct: (amt / current - 1) * 100, current, newCost: amt });
      return;
    }
    save();
  }

  return (
    <div className="space-y-6">
      {/* ---- Record a purchase ---- */}
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <label className="block text-xs font-medium text-gray-500">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="min-w-[16rem] grow">
          <label className="block text-xs font-medium text-gray-500">Component</label>
          <select
            value={componentId}
            onChange={(e) => setComponentId(e.target.value ? Number(e.target.value) : "")}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            {COMPONENT_TYPES.map((t) =>
              (byType.get(t) ?? []).length === 0 ? null : (
                <optgroup key={t} label={COMPONENT_TYPE_LABELS[t]}>
                  {(byType.get(t) ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({COMPONENT_UNIT_LABELS[c.unit]}
                      {c.currentCost === null ? "" : `, now ${fmt(c.currentCost)}/${COMPONENT_UNIT_LABELS[c.unit]}`})
                    </option>
                  ))}
                </optgroup>
              )
            )}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">Quantity</label>
          <input
            type="number"
            min="0"
            step="0.001"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="mt-1 w-24 rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">
            Amount (cost / {selected ? COMPONENT_UNIT_LABELS[selected.unit] : "unit"})
          </label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-28 rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="min-w-[12rem] grow">
          <label className="block text-xs font-medium text-gray-500">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Record purchase"}
        </button>
        {error && <p className="basis-full text-xs text-red-600">{error}</p>}
      </form>

      {/* ---- Purchases list ---- */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Component</th>
              <th className="px-3 py-2 text-right">Quantity</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Cost / unit</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialPurchases.map((p) => (
              <PurchaseRow key={p.id} purchase={p} />
            ))}
            {initialPurchases.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-gray-400">
                  No purchases recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---- 20%+ increase confirmation ---- */}
      {confirmIncrease && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-amber-700">Cost increase check</h2>
            <p className="mt-2 text-sm text-gray-700">
              This new cost of <span className="font-semibold">{fmt(confirmIncrease.newCost)}</span> is{" "}
              <span className="font-semibold">{confirmIncrease.pct.toFixed(0)}% more</span> than the current cost of{" "}
              <span className="font-semibold">{fmt(confirmIncrease.current)}</span>. Is this correct?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmIncrease(null)}
                disabled={submitting}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={submitting}
                className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Yes, save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PurchaseRow({ purchase: p }: { purchase: PurchaseRecord }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const unit = COMPONENT_UNIT_LABELS[p.unit];

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch("/api/purchases", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={`text-gray-700 ${busy ? "opacity-50" : ""}`}>
      <td className="px-3 py-2">{p.date}</td>
      <td className="px-3 py-2 text-gray-900">{p.componentName}</td>
      <td className="px-3 py-2 text-right">{p.quantity === null ? "—" : fmt(p.quantity)}</td>
      <td className="px-3 py-2 text-right">{fmt(p.amount)}</td>
      <td className="px-3 py-2 text-right text-gray-600">
        {fmt(p.amount)} /{unit}
      </td>
      <td className="px-3 py-2 text-gray-500">{p.description ? p.description : "—"}</td>
      <td className="px-3 py-2 text-right">
        <button type="button" onClick={remove} disabled={busy} className="px-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-50" title="Remove">
          ×
        </button>
      </td>
    </tr>
  );
}
