"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { egyptToday } from "@/lib/dates";
import type { AccountType, ExpenseRecord } from "@/lib/record-data/expenses";
import { MultiSelectFilter } from "./multi-select-filter";

// Expenses display (and will report) as negative, income as positive -
// the entered amount itself is always stored positive (validated at
// entry); the sign is purely a function of the account's type.
function fmtSignedAmount(amount: number, type: "income" | "expense"): string {
  const signed = type === "expense" ? -amount : amount;
  const formatted = Math.abs(signed).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return (signed < 0 ? `-${formatted}` : formatted) + " EGP";
}

// Single-level undo: only the most recent add/edit/delete can be reverted,
// and taking any new action replaces this rather than stacking.
type LastAction =
  | { kind: "add"; id: number }
  | { kind: "edit"; id: number; previous: ExpenseRecord }
  | { kind: "delete"; previous: ExpenseRecord[] };

export function ExpensesTab({
  accountTypes,
  initialRecords,
  canEdit = true,
}: {
  accountTypes: AccountType[];
  initialRecords: ExpenseRecord[];
  /** False = read-only: the figures are visible, but nothing can be added or changed. */
  canEdit?: boolean;
}) {
  const router = useRouter();

  const [date, setDate] = useState(egyptToday());
  const [accountTypeId, setAccountTypeId] = useState<number | "">(accountTypes[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterAccountTypeIds, setFilterAccountTypeIds] = useState<string[]>([]);
  const [filterKind, setFilterKind] = useState<"all" | "income" | "expense">("all");
  const [filterDescriptions, setFilterDescriptions] = useState<string[]>([]);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editAccountTypeId, setEditAccountTypeId] = useState<number | "">("");
  const [editDescription, setEditDescription] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editOriginal, setEditOriginal] = useState<ExpenseRecord | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const descriptionOptions = useMemo(() => {
    const unique = [...new Set(initialRecords.map((r) => r.description).filter((d): d is string => !!d && d.trim() !== ""))];
    return unique.sort((a, b) => a.localeCompare(b)).map((d) => ({ value: d, label: d }));
  }, [initialRecords]);

  // Like Excel's column filter, only account types that actually appear in
  // the recorded data are offered here - the form above (and the edit row)
  // still offer every account type, since you can record one for the first time.
  const accountTypeOptions = useMemo(() => {
    const byId = new Map<number, string>();
    for (const r of initialRecords) byId.set(r.accountTypeId, r.accountTypeName);
    return [...byId.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ value: String(id), label: name }));
  }, [initialRecords]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const amountNum = Number(amount);
    if (!date || !accountTypeId || !(amountNum > 0)) {
      setFormError("Date, account type, and a positive amount are required.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/record-data/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, accountTypeId, description, amount: amountNum }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");

      setLastAction({ kind: "add", id: data.id });
      setUndoError(null);
      setDescription("");
      setAmount("");
      router.refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  const filtered = useMemo(() => {
    return initialRecords.filter((r) => {
      if (filterFrom && r.date < filterFrom) return false;
      if (filterTo && r.date > filterTo) return false;
      if (filterAccountTypeIds.length > 0 && !filterAccountTypeIds.includes(String(r.accountTypeId))) return false;
      if (filterKind !== "all" && r.type !== filterKind) return false;
      if (filterDescriptions.length > 0 && !filterDescriptions.includes(r.description ?? "")) return false;
      return true;
    });
  }, [initialRecords, filterFrom, filterTo, filterAccountTypeIds, filterKind, filterDescriptions]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id));

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(filtered.map((r) => r.id)));
  }

  async function handleDeleteSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} record(s)?`)) return;

    const toDelete = initialRecords.filter((r) => selectedIds.has(r.id));

    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/record-data/expenses", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to delete");
      setLastAction({ kind: "delete", previous: toDelete });
      setUndoError(null);
      setSelectedIds(new Set());
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  function startEdit(r: ExpenseRecord) {
    setEditingId(r.id);
    setEditDate(r.date);
    setEditAccountTypeId(r.accountTypeId);
    setEditDescription(r.description ?? "");
    setEditAmount(String(r.amount));
    setEditOriginal(r);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit() {
    if (editingId === null) return;
    const amountNum = Number(editAmount);
    if (!editDate || !editAccountTypeId || !(amountNum > 0)) {
      setEditError("Date, account type, and a positive amount are required.");
      return;
    }

    setEditSubmitting(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/record-data/expenses/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: editDate, accountTypeId: editAccountTypeId, description: editDescription, amount: amountNum }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      if (editOriginal) {
        setLastAction({ kind: "edit", id: editingId, previous: editOriginal });
        setUndoError(null);
      }
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleUndo() {
    if (!lastAction) return;
    setUndoing(true);
    setUndoError(null);
    try {
      if (lastAction.kind === "add") {
        const res = await fetch("/api/record-data/expenses", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [lastAction.id] }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to undo");
      } else if (lastAction.kind === "edit") {
        const prev = lastAction.previous;
        const res = await fetch(`/api/record-data/expenses/${lastAction.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: prev.date,
            accountTypeId: prev.accountTypeId,
            description: prev.description ?? "",
            amount: prev.amount,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to undo");
      } else {
        for (const r of lastAction.previous) {
          const res = await fetch("/api/record-data/expenses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              date: r.date,
              accountTypeId: r.accountTypeId,
              description: r.description ?? "",
              amount: r.amount,
            }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to undo");
        }
      }

      setLastAction(null);
      router.refresh();
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : "Failed to undo");
    } finally {
      setUndoing(false);
    }
  }

  const inputClass = "mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm";
  const filterClass = "w-full rounded border border-gray-200 px-1.5 py-1 text-xs";
  const editInputClass = "w-full rounded border border-gray-300 px-1.5 py-1 text-xs";

  return (
    <div className="space-y-4">
      {/* Read-only viewers see the recorded figures but get no way to change
          them - the add form, the row Edit links and the bulk delete are all
          withheld. The API routes re-check the same right server-side. */}
      {canEdit && (
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <div className="w-full sm:w-auto">
          <label className="block text-xs font-medium text-gray-500">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required className={inputClass} />
        </div>
        <div className="w-full sm:w-auto">
          <label className="block text-xs font-medium text-gray-500">Account type</label>
          <select
            value={accountTypeId}
            onChange={(e) => setAccountTypeId(e.target.value ? Number(e.target.value) : "")}
            required
            className={inputClass}
          >
            {accountTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="w-full sm:flex-1 sm:min-w-[180px]">
          <label className="block text-xs font-medium text-gray-500">Description</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </div>
        <div className="w-full sm:w-auto">
          <label className="block text-xs font-medium text-gray-500">Amount (EGP)</label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className={inputClass}
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 sm:w-auto"
        >
          {submitting ? "Saving…" : "Add"}
        </button>
        {formError && <span className="text-xs text-red-600">{formError}</span>}
      </form>
      )}

      {lastAction && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <span>
            {lastAction.kind === "add" && "Record added."}
            {lastAction.kind === "edit" && "Record updated."}
            {lastAction.kind === "delete" && `${lastAction.previous.length} record(s) deleted.`}
          </span>
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoing}
            className="rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50"
          >
            {undoing ? "Undoing…" : "Undo"}
          </button>
          {undoError && <span className="text-xs text-red-600">{undoError}</span>}
        </div>
      )}

      {canEdit && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
          <span className="text-amber-800">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={handleDeleteSelected}
            disabled={deleting}
            className="rounded bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete selected"}
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="text-xs text-amber-800 hover:underline">
            Clear selection
          </button>
          {deleteError && <span className="text-xs text-red-600">{deleteError}</span>}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div>
          <label className="block text-xs font-medium text-gray-500">From</label>
          <input
            type="date"
            aria-label="From date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className={`${filterClass} w-auto`}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">To</label>
          <input
            type="date"
            aria-label="To date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            className={`${filterClass} w-auto`}
          />
        </div>
        <div className="w-36">
          <label className="block text-xs font-medium text-gray-500">Account type</label>
          <MultiSelectFilter options={accountTypeOptions} selected={filterAccountTypeIds} onChange={setFilterAccountTypeIds} />
        </div>
        <div className="w-28">
          <label className="block text-xs font-medium text-gray-500">Kind</label>
          <select
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value as "all" | "income" | "expense")}
            className={filterClass}
          >
            <option value="all">All</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
        </div>
        <div className="w-36">
          <label className="block text-xs font-medium text-gray-500">Description</label>
          <MultiSelectFilter options={descriptionOptions} selected={filterDescriptions} onChange={setFilterDescriptions} />
        </div>
      </div>

      {/* table-fixed with 7 columns is unreadable below sm - headers and
          cells overlap in ~360px. Mobile gets a card per record instead. */}
      <div className="hidden overflow-x-auto rounded-lg border border-gray-200 sm:block">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-400">
            <tr>
              <th className="w-[4%] px-3 py-2">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label="Select all" />
              </th>
              <th className="w-[15%] px-3 py-2">Date</th>
              <th className="w-[18%] px-3 py-2">Account type</th>
              <th className="w-[9%] px-3 py-2">Kind</th>
              <th className="w-[28%] px-3 py-2">Description</th>
              <th className="w-[16%] px-3 py-2 text-right">Amount</th>
              <th className="w-[10%] px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((r) => {
              if (editingId === r.id) {
                const previewType = accountTypes.find((t) => t.id === editAccountTypeId)?.type ?? r.type;
                return (
                  <tr key={r.id} className="bg-blue-50/40">
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2">
                      <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} className={editInputClass} />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={editAccountTypeId}
                        onChange={(e) => setEditAccountTypeId(e.target.value ? Number(e.target.value) : "")}
                        className={editInputClass}
                      >
                        {accountTypes.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          previewType === "income" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                        }`}
                      >
                        {previewType === "income" ? "Income" : "Expense"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        className={editInputClass}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                        className={editInputClass}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={saveEdit}
                            disabled={editSubmitting}
                            className="rounded bg-gray-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                          >
                            {editSubmitting ? "…" : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="rounded border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                          >
                            Cancel
                          </button>
                        </div>
                        {editError && <span className="text-[11px] text-red-600">{editError}</span>}
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={r.id} className="text-gray-700">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleSelected(r.id)}
                      aria-label={`Select record ${r.id}`}
                    />
                  </td>
                  <td className="px-3 py-2">{r.date}</td>
                  <td className="px-3 py-2">{r.accountTypeName}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        r.type === "income" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                      }`}
                    >
                      {r.type === "income" ? "Income" : "Expense"}
                    </span>
                  </td>
                  <td className="truncate px-3 py-2">{r.description}</td>
                  <td className={`px-3 py-2 text-right ${r.type === "expense" ? "text-red-700" : "text-green-700"}`}>
                    {fmtSignedAmount(r.amount, r.type)}
                  </td>
                  <td className="px-3 py-2">
                    {canEdit && (
                      <button type="button" onClick={() => startEdit(r)} className="text-xs font-medium text-gray-600 hover:underline">
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-gray-400">
                  No records match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 sm:hidden">
        {filtered.map((r) => {
          if (editingId === r.id) {
            return (
              <div key={r.id} className="space-y-2 bg-blue-50/40 p-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500">Date</label>
                  <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} className={editInputClass} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500">Account type</label>
                  <select
                    value={editAccountTypeId}
                    onChange={(e) => setEditAccountTypeId(e.target.value ? Number(e.target.value) : "")}
                    className={editInputClass}
                  >
                    {accountTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500">Description</label>
                  <input
                    type="text"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    className={editInputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500">Amount (EGP)</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    className={editInputClass}
                  />
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={editSubmitting}
                    className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                  >
                    {editSubmitting ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                  >
                    Cancel
                  </button>
                </div>
                {editError && <span className="text-[11px] text-red-600">{editError}</span>}
              </div>
            );
          }

          return (
            <div key={r.id} className="flex items-start gap-2 p-3">
              <input
                type="checkbox"
                checked={selectedIds.has(r.id)}
                onChange={() => toggleSelected(r.id)}
                aria-label={`Select record ${r.id}`}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-900">{r.date}</span>
                  <span className={`text-sm font-medium ${r.type === "expense" ? "text-red-700" : "text-green-700"}`}>
                    {fmtSignedAmount(r.amount, r.type)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs">
                  <span
                    className={`rounded px-1.5 py-0.5 font-medium ${
                      r.type === "income" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                    }`}
                  >
                    {r.type === "income" ? "Income" : "Expense"}
                  </span>
                  <span className="truncate text-gray-500">{r.accountTypeName}</span>
                </div>
                {r.description && <div className="mt-1 truncate text-xs text-gray-600">{r.description}</div>}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => startEdit(r)}
                    className="mt-1 text-xs font-medium text-gray-600 hover:underline"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="p-4 text-center text-sm text-gray-400">No records match these filters.</div>}
      </div>
    </div>
  );
}
