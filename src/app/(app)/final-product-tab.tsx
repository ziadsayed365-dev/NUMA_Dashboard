"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ALLOCATION_UNIT_LABELS,
  COMPONENT_TYPE_LABELS,
  COMPONENT_UNIT_LABELS,
  computeLineCost,
  type ComponentType,
  type ComponentUnit,
  type ProductComponent,
} from "@/lib/products/component-types";
import type {
  BundleItem,
  BundleProduct,
  FinalProduct,
  MemberOption,
  OtherComponentOption,
  ProductMapping,
  ProductStructure,
} from "@/lib/products/final-products";

// Single products map to raw material / packaging / other.
const SINGLE_TYPES: ComponentType[] = ["raw_material", "product_package", "other"];
const SINGLE_COL_WIDTH: Record<ComponentType, string> = {
  raw_material: "w-[26%]",
  product_package: "w-[20%]",
  other: "w-[20%]",
};

function fmt(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// A bundle item's live line cost: a product member is counted in whole pieces,
// a component uses its allocation unit (g / ml / pc) via computeLineCost.
function bundleItemLineCost(item: Pick<BundleItem, "kind" | "perUnitCost" | "unit">, quantity: number): number | null {
  if (item.perUnitCost === null) return null;
  if (item.kind === "product") return item.perUnitCost * quantity;
  return computeLineCost(item.perUnitCost, item.unit ?? "pcs", quantity);
}

export function FinalProductTab({ structure, components }: { structure: ProductStructure; components: ProductComponent[] }) {
  const { singles, bundles, memberOptions, otherComponents } = structure;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const componentsByType = useMemo(() => {
    const map: Record<ComponentType, ProductComponent[]> = { raw_material: [], product_package: [], other: [] };
    for (const c of components) map[c.type].push(c);
    return map;
  }, [components]);

  const matches = (name: string, sku: string | null) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return name.toLowerCase().includes(q) || (sku ?? "").toLowerCase().includes(q);
  };
  const showByStatus = (active: boolean) => statusFilter === "all" || active;

  const filteredSingles = singles.filter((p) => showByStatus(p.isActive) && matches(p.name, p.sku));
  const filteredBundles = bundles.filter((b) => showByStatus(b.isActive) && matches(b.name, null));

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-400">
        Single products are built from raw materials, packaging and other costs. Bundles are built from single products (and
        an optional box), chosen from one dropdown. Quantities: grams for KG, ml for L, pieces otherwise.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name or SKU…"
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
      </div>

      {/* ---- Single products ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-800">
          Single Products <span className="font-normal text-gray-400">({filteredSingles.length})</span>
        </h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full table-fixed divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="w-[22%] px-3 py-2">Product</th>
                {SINGLE_TYPES.map((t) => (
                  <th key={t} className={`${SINGLE_COL_WIDTH[t]} px-2 py-2`}>
                    {COMPONENT_TYPE_LABELS[t]}
                  </th>
                ))}
                <th className="w-[12%] px-2 py-2 text-right">Built cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredSingles.map((product) => {
                const hasVariants = product.variants.length > 0;
                const isOpen = hasVariants && expanded.has(product.id);
                return (
                  <Fragment key={product.id}>
                    <tr className="align-top">
                      <td className="px-3 py-2 text-gray-900">
                        {hasVariants ? (
                          <button
                            type="button"
                            onClick={() => toggleExpand(product.id)}
                            className="mr-1.5 inline-flex w-4 justify-center text-gray-400 hover:text-gray-700"
                            aria-label={isOpen ? "Collapse variants" : "Expand variants"}
                          >
                            {isOpen ? "▾" : "▸"}
                          </button>
                        ) : (
                          <span className="mr-1.5 inline-block w-4" />
                        )}
                        <span className="break-words">{product.name}</span>
                        {hasVariants && (
                          <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                            {product.variants.length} variants
                          </span>
                        )}
                        {!product.isActive && (
                          <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">inactive</span>
                        )}
                        <KindToggle productId={product.id} makeBundle />
                      </td>
                      {SINGLE_TYPES.map((t) =>
                        // For a multi-variant product the raw material differs per
                        // variant, so it's edited in the expanded rows below, not here.
                        hasVariants && t === "raw_material" ? (
                          <td key={t} className="px-2 py-2 align-middle text-[11px] text-gray-400">
                            per variant {isOpen ? "↓" : "→ expand"}
                          </td>
                        ) : (
                          <td key={t} className="px-2 py-2">
                            <MappingCell
                              endpoint={`/api/final-products/${product.id}/components`}
                              options={componentsByType[t]}
                              assigned={product.mappings.filter((m) => m.type === t)}
                            />
                          </td>
                        )
                      )}
                      <td className="px-2 py-2 text-right">
                        <div className="font-medium text-gray-900">{product.mappings.length === 0 ? "—" : fmt(product.totalCost)}</div>
                        {hasVariants ? (
                          <div className="text-[10px] text-gray-400">shared base</div>
                        ) : (
                          product.hasMissingCost && <div className="text-[10px] text-amber-600">some costs missing</div>
                        )}
                      </td>
                    </tr>

                    {isOpen &&
                      product.variants.map((v) => (
                        <tr key={`v-${v.variantId}`} className="bg-gray-50/60 align-top">
                          <td className="py-2 pl-10 pr-3 text-gray-700">
                            <span className="break-words">{v.title || v.sku || `Variant #${v.variantId}`}</span>
                            {v.sku && v.title && <span className="ml-2 text-[11px] text-gray-400">{v.sku}</span>}
                          </td>
                          {SINGLE_TYPES.map((t) =>
                            t === "raw_material" ? (
                              <td key={t} className="px-2 py-2">
                                <MappingCell
                                  endpoint={`/api/variants/${v.variantId}/components`}
                                  options={componentsByType[t]}
                                  assigned={v.mappings.filter((m) => m.type === t)}
                                />
                              </td>
                            ) : (
                              <td key={t} className="px-2 py-2 text-[11px] text-gray-300">
                                shared
                              </td>
                            )
                          )}
                          <td className="px-2 py-2 text-right">
                            <div className="font-medium text-gray-900">{v.mappings.length === 0 ? "—" : fmt(v.builtCost)}</div>
                            {v.hasMissingCost && <div className="text-[10px] text-amber-600">some costs missing</div>}
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
              {filteredSingles.length === 0 && (
                <tr>
                  <td colSpan={SINGLE_TYPES.length + 2} className="px-3 py-4 text-center text-gray-400">
                    No single products match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Bundles ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-800">
          Bundles <span className="font-normal text-gray-400">({filteredBundles.length})</span>
        </h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full table-fixed divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="w-[30%] px-3 py-2">Bundle</th>
                <th className="w-[55%] px-2 py-2">Contents (single products + box)</th>
                <th className="w-[15%] px-2 py-2 text-right">Built cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredBundles.map((bundle) => (
                <tr key={bundle.id} className="align-top">
                  <td className="px-3 py-2 text-gray-900">
                    <span className="break-words">{bundle.name}</span>
                    {!bundle.isActive && (
                      <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">inactive</span>
                    )}
                    <KindToggle productId={bundle.id} makeBundle={false} />
                  </td>
                  <td className="px-2 py-2">
                    <BundleContentsCell bundle={bundle} memberOptions={memberOptions} otherComponents={otherComponents} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <div className="font-medium text-gray-900">{bundle.items.length === 0 ? "—" : fmt(bundle.totalCost)}</div>
                    {bundle.hasMissingCost && <div className="text-[10px] text-amber-600">some costs missing</div>}
                  </td>
                </tr>
              ))}
              {filteredBundles.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-center text-gray-400">
                    No bundles match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// Flip a product between single and bundle.
function KindToggle({ productId, makeBundle }: { productId: number; makeBundle: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/final-products/${productId}/kind`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isBundle: makeBundle }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      className="mt-1 block text-[11px] text-gray-400 hover:text-gray-700 hover:underline disabled:opacity-50"
    >
      {makeBundle ? "→ mark as bundle" : "→ mark as single product"}
    </button>
  );
}

// ---- Component mapping cell, reused for a product's shared components and for
// a single variant's own components (only the POST/DELETE endpoint differs). ----
function MappingCell({
  endpoint,
  options,
  assigned,
}: {
  endpoint: string;
  options: ProductComponent[];
  assigned: ProductMapping[];
}) {
  const router = useRouter();
  const [addId, setAddId] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usedIds = new Set(assigned.map((m) => m.componentId));
  const available = options.filter((o) => !usedIds.has(o.id));

  async function add() {
    setError(null);
    if (!addId) return;
    const qty = Number(addQty);
    if (!Number.isFinite(qty) || qty < 0) {
      setError("Bad qty");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ componentId: Number(addId), quantity: qty }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      setAddId("");
      setAddQty("1");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      {assigned.map((m) => (
        <AssignedLine key={m.componentId} endpoint={endpoint} mapping={m} />
      ))}

      {available.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <select
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 basis-full rounded border border-gray-300 px-1 py-1 text-xs"
          >
            <option value="">+ add…</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.account} ({o.cost === null ? "no cost" : `${fmt(o.cost)}/${COMPONENT_UNIT_LABELS[o.unit]}`})
              </option>
            ))}
          </select>
          {addId && (
            <>
              <input
                type="number"
                min="0"
                step="0.001"
                value={addQty}
                onChange={(e) => setAddQty(e.target.value)}
                disabled={busy}
                className="w-14 rounded border border-gray-300 px-1 py-1 text-xs text-right"
              />
              <span className="text-[10px] text-gray-400">
                {ALLOCATION_UNIT_LABELS[available.find((o) => o.id === Number(addId))?.unit ?? "pcs"]}
              </span>
              <button
                type="button"
                onClick={add}
                disabled={busy}
                className="rounded bg-gray-900 px-2 py-1 text-xs text-white hover:bg-gray-700 disabled:opacity-50"
              >
                Add
              </button>
            </>
          )}
        </div>
      ) : (
        assigned.length === 0 && <span className="text-xs text-gray-300">—</span>
      )}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

function AssignedLine({ endpoint, mapping }: { endpoint: string; mapping: ProductMapping }) {
  const router = useRouter();
  const [qty, setQty] = useState(String(mapping.quantity));
  const [busy, setBusy] = useState(false);
  const dirty = qty.trim() !== "" && Number(qty) !== mapping.quantity;

  async function save() {
    const q = Number(qty);
    if (!Number.isFinite(q) || q < 0) return;
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ componentId: mapping.componentId, quantity: q }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ componentId: mapping.componentId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-1 rounded bg-gray-50 px-1.5 py-1 ${busy ? "opacity-50" : ""}`}>
      <span className="basis-full truncate text-xs text-gray-700" title={mapping.account}>
        {mapping.account}
      </span>
      <input
        type="number"
        min="0"
        step="0.001"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        disabled={busy}
        className="w-12 rounded border border-gray-300 px-1 py-0.5 text-xs text-right"
      />
      <span className="text-[10px] text-gray-400">{ALLOCATION_UNIT_LABELS[mapping.unit]}</span>
      <span className="flex-1 text-right text-[11px] text-gray-500" title="line cost">
        {fmt(computeLineCost(mapping.costPerUnit, mapping.unit, Number(qty || 0)))}
      </span>
      {dirty ? (
        <button type="button" onClick={save} disabled={busy} className="rounded bg-gray-900 px-1.5 py-0.5 text-[11px] text-white hover:bg-gray-700">
          Save
        </button>
      ) : (
        <button type="button" onClick={remove} disabled={busy} className="px-1 text-xs text-red-500 hover:text-red-700" title="Remove">
          ×
        </button>
      )}
    </div>
  );
}

// ---- Bundle contents: single products + Other components in one dropdown ----
function BundleContentsCell({
  bundle,
  memberOptions,
  otherComponents,
}: {
  bundle: BundleProduct;
  memberOptions: MemberOption[];
  otherComponents: OtherComponentOption[];
}) {
  const router = useRouter();
  const [addValue, setAddValue] = useState(""); // "p:<id>" or "c:<id>"
  const [addQty, setAddQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usedProducts = new Set(bundle.items.filter((i) => i.kind === "product").map((i) => i.refId));
  const usedComponents = new Set(bundle.items.filter((i) => i.kind === "component").map((i) => i.refId));
  const availableMembers = memberOptions.filter((m) => m.id !== bundle.id && !usedProducts.has(m.id));
  const availableComponents = otherComponents.filter((c) => !usedComponents.has(c.id));

  function refFromValue(value: string): { memberProductId?: number; componentId?: number } | null {
    if (value.startsWith("p:")) return { memberProductId: Number(value.slice(2)) };
    if (value.startsWith("c:")) return { componentId: Number(value.slice(2)) };
    return null;
  }

  async function add() {
    setError(null);
    const ref = refFromValue(addValue);
    if (!ref) return;
    const qty = Number(addQty);
    if (!Number.isFinite(qty) || qty < 0) {
      setError("Bad qty");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/bundles/${bundle.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...ref, quantity: qty }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      setAddValue("");
      setAddQty("1");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      {bundle.items.map((item) => (
        <BundleItemLine key={`${item.kind}:${item.refId}`} bundleId={bundle.id} item={item} />
      ))}

      {availableMembers.length > 0 || availableComponents.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <select
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 basis-full rounded border border-gray-300 px-1 py-1 text-xs"
          >
            <option value="">+ add to bundle…</option>
            {availableMembers.length > 0 && (
              <optgroup label="Single products">
                {availableMembers.map((m) => (
                  <option key={`p${m.id}`} value={`p:${m.id}`}>
                    {m.name} (built {fmt(m.builtCost)})
                  </option>
                ))}
              </optgroup>
            )}
            {availableComponents.length > 0 && (
              <optgroup label="Other components (box)">
                {availableComponents.map((c) => (
                  <option key={`c${c.id}`} value={`c:${c.id}`}>
                    {c.account} ({c.cost === null ? "no cost" : `${fmt(c.cost)}/${COMPONENT_UNIT_LABELS[c.unit]}`})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {addValue && (
            <>
              <input
                type="number"
                min="0"
                step="0.001"
                value={addQty}
                onChange={(e) => setAddQty(e.target.value)}
                disabled={busy}
                className="w-14 rounded border border-gray-300 px-1 py-1 text-xs text-right"
              />
              <button
                type="button"
                onClick={add}
                disabled={busy}
                className="rounded bg-gray-900 px-2 py-1 text-xs text-white hover:bg-gray-700 disabled:opacity-50"
              >
                Add
              </button>
            </>
          )}
        </div>
      ) : (
        bundle.items.length === 0 && <span className="text-xs text-gray-300">—</span>
      )}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

function BundleItemLine({ bundleId, item }: { bundleId: number; item: BundleItem }) {
  const router = useRouter();
  const [qty, setQty] = useState(String(item.quantity));
  const [busy, setBusy] = useState(false);
  const dirty = qty.trim() !== "" && Number(qty) !== item.quantity;
  const ref = item.kind === "product" ? { memberProductId: item.refId } : { componentId: item.refId };
  const unitLabel = item.kind === "product" ? "pc" : ALLOCATION_UNIT_LABELS[item.unit ?? "pcs"];

  async function save() {
    const q = Number(qty);
    if (!Number.isFinite(q) || q < 0) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bundles/${bundleId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...ref, quantity: q }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/bundles/${bundleId}/items`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ref),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-1 rounded px-1.5 py-1 ${item.kind === "product" ? "bg-indigo-50" : "bg-gray-50"} ${busy ? "opacity-50" : ""}`}>
      <span className="basis-full truncate text-xs text-gray-700" title={item.label}>
        {item.kind === "component" && <span className="mr-1 text-[9px] uppercase text-gray-400">box</span>}
        {item.label}
      </span>
      <input
        type="number"
        min="0"
        step="0.001"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        disabled={busy}
        className="w-12 rounded border border-gray-300 px-1 py-0.5 text-xs text-right"
      />
      <span className="text-[10px] text-gray-400">{unitLabel}</span>
      <span className="flex-1 text-right text-[11px] text-gray-500" title="line cost">
        {fmt(bundleItemLineCost(item, Number(qty || 0)))}
      </span>
      {dirty ? (
        <button type="button" onClick={save} disabled={busy} className="rounded bg-gray-900 px-1.5 py-0.5 text-[11px] text-white hover:bg-gray-700">
          Save
        </button>
      ) : (
        <button type="button" onClick={remove} disabled={busy} className="px-1 text-xs text-red-500 hover:text-red-700" title="Remove">
          ×
        </button>
      )}
    </div>
  );
}
