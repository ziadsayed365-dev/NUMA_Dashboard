"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  COMPONENT_TYPES,
  COMPONENT_TYPE_LABELS,
  COMPONENT_UNITS,
  COMPONENT_UNIT_LABELS,
  type ComponentType,
  type ComponentUnit,
  type ProductComponent,
} from "@/lib/products/component-types";

const inputClass = "mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm";
const editInputClass = "w-full rounded border border-gray-300 px-1.5 py-1 text-xs";

function formatMoney(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function ProductComponentsTab({ initialComponents }: { initialComponents: ProductComponent[] }) {
  const router = useRouter();

  // Add form
  const [type, setType] = useState<ComponentType>("raw_material");
  const [account, setAccount] = useState("");
  const [unit, setUnit] = useState<ComponentUnit>("pcs");
  const [cost, setCost] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Filter
  const [typeFilter, setTypeFilter] = useState<ComponentType | "all">("all");

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editType, setEditType] = useState<ComponentType>("raw_material");
  const [editAccount, setEditAccount] = useState("");
  const [editUnit, setEditUnit] = useState<ComponentUnit>("pcs");
  const [editCost, setEditCost] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const filtered = useMemo(
    () => (typeFilter === "all" ? initialComponents : initialComponents.filter((c) => c.type === typeFilter)),
    [initialComponents, typeFilter]
  );

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!account.trim()) {
      setFormError("Account name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/product-components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, account, unit, cost: cost.trim() === "" ? null : Number(cost) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to add");
      setAccount("");
      setCost("");
      router.refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(c: ProductComponent) {
    setEditingId(c.id);
    setEditType(c.type);
    setEditAccount(c.account);
    setEditUnit(c.unit);
    setEditCost(c.cost !== null ? String(c.cost) : "");
    setRowError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setRowError(null);
  }

  async function saveEdit() {
    if (editingId === null) return;
    if (!editAccount.trim()) {
      setRowError("Account name is required.");
      return;
    }
    setEditSubmitting(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/product-components/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: editType, account: editAccount, unit: editUnit, cost: editCost.trim() === "" ? null : Number(editCost) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleDelete(c: ProductComponent) {
    if (!confirm(`Delete "${c.account}"?`)) return;
    setRowError(null);
    try {
      const res = await fetch("/api/product-components", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [c.id] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to delete");
      router.refresh();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  // Export the full component list as an Excel-compatible CSV. The UTF-8 BOM
  // makes Excel read the Arabic account names correctly.
  function exportToExcel() {
    const header = ["Type", "Account", "Unit", "Cost/unit"];
    const rows = initialComponents.map((c) => [
      COMPONENT_TYPE_LABELS[c.type],
      c.account,
      COMPONENT_UNIT_LABELS[c.unit],
      c.cost === null ? "" : String(c.cost),
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const BOM = String.fromCharCode(0xfeff);
    const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `product-components-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400">
        The raw materials, packaging and other inputs your products are built from. Add each with its unit and cost — the
        Final Product tab will reference these to build up each product&apos;s cost.
      </p>

      {/* Add form */}
      <form
        onSubmit={handleAdd}
        className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <div className="w-full sm:w-auto">
          <label className="block text-xs font-medium text-gray-500">Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as ComponentType)} className={inputClass}>
            {COMPONENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {COMPONENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="w-full sm:flex-1 sm:min-w-[200px]">
          <label className="block text-xs font-medium text-gray-500">Account</label>
          <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. Argan Oil 100ml" className={inputClass} />
        </div>
        <div className="w-full sm:w-auto">
          <label className="block text-xs font-medium text-gray-500">Unit</label>
          <select value={unit} onChange={(e) => setUnit(e.target.value as ComponentUnit)} className={inputClass}>
            {COMPONENT_UNITS.map((u) => (
              <option key={u} value={u}>
                {COMPONENT_UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </div>
        <div className="w-full sm:w-32">
          <label className="block text-xs font-medium text-gray-500">Cost (EGP)</label>
          <input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} className={inputClass} />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 sm:w-auto"
        >
          {submitting ? "Adding…" : "Add"}
        </button>
        {formError && <span className="text-xs text-red-600">{formError}</span>}
      </form>

      {/* Type filter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Filter:</span>
        <div className="flex flex-wrap rounded-md border border-gray-300 text-xs font-medium">
          <button
            type="button"
            onClick={() => setTypeFilter("all")}
            className={`px-3 py-1.5 ${typeFilter === "all" ? "bg-gray-900 text-white" : "bg-white text-gray-600"}`}
          >
            All
          </button>
          {COMPONENT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 ${typeFilter === t ? "bg-gray-900 text-white" : "bg-white text-gray-600"}`}
            >
              {COMPONENT_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">
          {filtered.length} of {initialComponents.length}
        </span>
        {rowError && <span className="text-xs text-red-600">{rowError}</span>}
        <button
          type="button"
          onClick={exportToExcel}
          disabled={initialComponents.length === 0}
          className="ml-auto rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          ⬇ Export to Excel
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2">Unit</th>
              <th className="px-3 py-2 text-right">Cost / unit (EGP)</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((c) => {
              if (editingId === c.id) {
                return (
                  <tr key={c.id} className="bg-blue-50/40">
                    <td className="px-3 py-2">
                      <select value={editType} onChange={(e) => setEditType(e.target.value as ComponentType)} className={editInputClass}>
                        {COMPONENT_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {COMPONENT_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input type="text" value={editAccount} onChange={(e) => setEditAccount(e.target.value)} className={editInputClass} />
                    </td>
                    <td className="px-3 py-2">
                      <select value={editUnit} onChange={(e) => setEditUnit(e.target.value as ComponentUnit)} className={editInputClass}>
                        {COMPONENT_UNITS.map((u) => (
                          <option key={u} value={u}>
                            {COMPONENT_UNIT_LABELS[u]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" min="0" step="0.01" value={editCost} onChange={(e) => setEditCost(e.target.value)} className={`${editInputClass} text-right`} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <button type="button" onClick={saveEdit} disabled={editSubmitting} className="rounded bg-gray-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50">
                          {editSubmitting ? "…" : "Save"}
                        </button>
                        <button type="button" onClick={cancelEdit} className="rounded border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={c.id} className="text-gray-700">
                  <td className="px-3 py-2">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">{COMPONENT_TYPE_LABELS[c.type]}</span>
                  </td>
                  <td className="px-3 py-2 text-gray-900">{c.account}</td>
                  <td className="px-3 py-2 text-gray-500">{COMPONENT_UNIT_LABELS[c.unit]}</td>
                  <td className="px-3 py-2 text-right">{formatMoney(c.cost)}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <button type="button" onClick={() => startEdit(c)} className="text-xs font-medium text-gray-600 hover:underline">
                        Edit
                      </button>
                      <button type="button" onClick={() => handleDelete(c)} className="text-xs font-medium text-red-600 hover:underline">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-gray-400">
                  No components yet. Add your first one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
