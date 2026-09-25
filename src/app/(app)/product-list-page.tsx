"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogProduct, ModelGroupOption } from "@/lib/products/catalog";

const inputClass = "w-full rounded border border-gray-300 px-1.5 py-1 text-xs";
const NEW_GROUP_VALUE = "__new__";

function formatMoney(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function ProductListPage({ products, modelGroups }: { products: CatalogProduct[]; modelGroups: ModelGroupOption[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter((p) => {
      if (statusFilter === "active" && !p.isActive) return false;
      if (query && !p.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [products, search, statusFilter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by title…"
          className="w-64 rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
        <div className="flex rounded-md border border-gray-300 text-xs font-medium">
          <button
            type="button"
            onClick={() => setStatusFilter("active")}
            className={`rounded-l-md px-3 py-1.5 ${statusFilter === "active" ? "bg-gray-900 text-white" : "bg-white text-gray-600"}`}
          >
            Active only
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter("all")}
            className={`rounded-r-md px-3 py-1.5 ${statusFilter === "all" ? "bg-gray-900 text-white" : "bg-white text-gray-600"}`}
          >
            All statuses
          </button>
        </div>
        <span className="text-xs text-gray-400">
          {filtered.length} of {products.length} products
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Price (EGP)</th>
              <th className="px-3 py-2">Model group</th>
              <th className="px-3 py-2">Unit cost (EGP)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((product) => (
              <ProductRow key={product.id} product={product} modelGroups={modelGroups} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProductRow({ product, modelGroups }: { product: CatalogProduct; modelGroups: ModelGroupOption[] }) {
  const router = useRouter();
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupCost, setNewGroupCost] = useState("");
  const [costInput, setCostInput] = useState(product.unitCost !== null ? String(product.unitCost) : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the cost field when the server gives us a fresh value after a
  // refresh - editing the cost from any row sharing this model group should
  // update every other row showing it, but local state only initializes once.
  useEffect(() => {
    setCostInput(product.unitCost !== null ? String(product.unitCost) : "");
  }, [product.unitCost]);

  const savedCostValue = product.unitCost !== null ? String(product.unitCost) : "";
  const costDirty = costInput !== savedCostValue;

  async function assignModelGroup(modelGroupId: number | null) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelGroupId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to assign model group");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign model group");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGroupChange(value: string) {
    if (value === NEW_GROUP_VALUE) {
      setCreatingGroup(true);
      return;
    }
    await assignModelGroup(value === "" ? null : Number(value));
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newGroupName.trim()) {
      setError("Model name is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/model-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName, unitCost: newGroupCost.trim() ? Number(newGroupCost) : null }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to create model group");
      setCreatingGroup(false);
      setNewGroupName("");
      setNewGroupCost("");
      await assignModelGroup(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create model group");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveCost() {
    if (!product.modelGroupId) return;
    const trimmed = costInput.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && !Number.isFinite(parsed)) {
      setError("Cost must be a number.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/model-groups/${product.modelGroupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitCost: parsed }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to update cost");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update cost");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <tr className={submitting ? "opacity-60" : ""}>
      <td className="px-3 py-2 text-gray-900">
        {product.name}
        {!product.isActive && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">inactive</span>}
      </td>
      <td className="px-3 py-2 text-gray-500">{product.sku ?? "—"}</td>
      <td className="px-3 py-2 text-gray-500">{formatMoney(product.currentPrice)}</td>
      <td className="px-3 py-2">
        {creatingGroup ? (
          <form onSubmit={handleCreateGroup} className="flex items-center gap-1">
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="New model name"
              className={inputClass}
              autoFocus
            />
            <input
              value={newGroupCost}
              onChange={(e) => setNewGroupCost(e.target.value)}
              placeholder="Cost"
              type="number"
              className={`${inputClass} w-20`}
            />
            <button type="submit" disabled={submitting} className="rounded bg-gray-900 px-2 py-1 text-xs text-white">
              Save
            </button>
            <button type="button" onClick={() => setCreatingGroup(false)} className="text-xs text-gray-400">
              Cancel
            </button>
          </form>
        ) : (
          <select value={product.modelGroupId ?? ""} disabled={submitting} onChange={(e) => handleGroupChange(e.target.value)} className={inputClass}>
            <option value="">— unassigned —</option>
            {modelGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            <option value={NEW_GROUP_VALUE}>+ New model…</option>
          </select>
        )}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <input
            value={costInput}
            onChange={(e) => setCostInput(e.target.value)}
            disabled={!product.modelGroupId || submitting}
            placeholder={product.modelGroupId ? "" : "assign a model first"}
            type="number"
            className={`${inputClass} w-24`}
          />
          <button
            type="button"
            onClick={handleSaveCost}
            disabled={!product.modelGroupId || submitting || !costDirty}
            className="rounded bg-gray-900 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </td>
    </tr>
  );
}
