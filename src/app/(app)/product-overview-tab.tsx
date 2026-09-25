"use client";

import { Fragment, useMemo, useState } from "react";
import type { ProductStructure } from "@/lib/products/final-products";
import type { ProductVariant } from "@/lib/products/variants";

function fmt(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtPct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

type Row = {
  id: number;
  name: string;
  isBundle: boolean;
  isActive: boolean;
  price: number | null;
  cost: number | null; // null when nothing costed yet
  margin: number | null; // (price - cost) / price
};

export function ProductOverviewTab({
  structure,
  variants,
}: {
  structure: ProductStructure;
  variants: ProductVariant[];
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Group variants under their product; only products with more than one variant
  // are worth expanding (a single "Default Title" variant tells you nothing the
  // product row doesn't already).
  const variantsByProduct = useMemo(() => {
    const map = new Map<number, ProductVariant[]>();
    for (const v of variants) {
      const list = map.get(v.productId) ?? [];
      list.push(v);
      map.set(v.productId, list);
    }
    return map;
  }, [variants]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = useMemo<Row[]>(() => {
    const toRow = (base: { id: number; name: string; currentPrice: number | null; isActive: boolean }, isBundle: boolean, totalCost: number, hasCost: boolean): Row => {
      const cost = hasCost ? totalCost : null;
      const price = base.currentPrice;
      const margin = price !== null && price > 0 && cost !== null ? (price - cost) / price : null;
      return { id: base.id, name: base.name, isBundle, isActive: base.isActive, price, cost, margin };
    };
    return [
      ...structure.bundles.map((b) => toRow(b, true, b.totalCost, b.items.length > 0)),
      ...structure.singles.map((s) => {
        // A multi-variant product's real cost includes each variant's own raw
        // material, so the collapsed row shows the average built cost across
        // variants - matching the expanded per-variant rows - not the bare
        // shared base. Single-variant products use the shared base as before.
        if (s.variants.length > 0) {
          const hasCost = s.mappings.length > 0 || s.variants.some((v) => v.mappings.length > 0);
          const avg = s.variants.reduce((sum, v) => sum + v.builtCost, 0) / s.variants.length;
          return toRow(s, false, avg, hasCost);
        }
        return toRow(s, false, s.totalCost, s.mappings.length > 0);
      }),
    ];
  }, [structure]);

  const filtered = rows.filter((r) => {
    if (statusFilter === "active" && !r.isActive) return false;
    const q = search.trim().toLowerCase();
    if (q && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        Price is synced from Shopify; Cost is the built cost from the Final Product tab; Gross Margin = (Price − Cost) ÷ Price.
        Products sold in several variants (e.g. sizes) can be expanded to see each variant&apos;s own price; per-variant cost is
        pending the variant bill of materials.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name…"
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
        <span className="text-xs text-gray-400">{filtered.length} items</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full table-fixed divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="w-[46%] px-3 py-2">Name</th>
              <th className="w-[18%] px-3 py-2 text-right">Price (EGP)</th>
              <th className="w-[18%] px-3 py-2 text-right">Cost (EGP)</th>
              <th className="w-[18%] px-3 py-2 text-right">Gross Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((r) => {
              const productVariants = r.isBundle ? [] : variantsByProduct.get(r.id) ?? [];
              const canExpand = productVariants.length > 1;
              const isOpen = canExpand && expanded.has(r.id);
              return (
                <Fragment key={`${r.isBundle ? "b" : "s"}-${r.id}`}>
                  <tr className="text-gray-700">
                    <td className="px-3 py-2 text-gray-900">
                      {canExpand ? (
                        <button
                          type="button"
                          onClick={() => toggle(r.id)}
                          className="mr-1.5 inline-flex w-4 justify-center text-gray-400 hover:text-gray-700"
                          aria-label={isOpen ? "Collapse variants" : "Expand variants"}
                        >
                          {isOpen ? "▾" : "▸"}
                        </button>
                      ) : (
                        <span className="mr-1.5 inline-block w-4" />
                      )}
                      {r.isBundle && (
                        <span className="mr-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">bundle</span>
                      )}
                      <span className="break-words">{r.name}</span>
                      {canExpand && (
                        <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                          {productVariants.length} variants
                        </span>
                      )}
                      {!r.isActive && (
                        <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">inactive</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(r.price)}</td>
                    <td className="px-3 py-2 text-right">
                      {r.cost === null ? <span className="text-gray-300">—</span> : fmt(r.cost)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-medium ${
                        r.margin === null ? "text-gray-300" : r.margin < 0 ? "text-red-600" : "text-green-700"
                      }`}
                    >
                      {fmtPct(r.margin)}
                    </td>
                  </tr>
                  {isOpen &&
                    productVariants.map((v) => {
                      const vMargin =
                        v.currentPrice !== null && v.currentPrice > 0 && v.unitCost !== null
                          ? (v.currentPrice - v.unitCost) / v.currentPrice
                          : null;
                      return (
                        <tr key={`v-${v.id}`} className="bg-gray-50/60 text-gray-600">
                          <td className="py-1.5 pl-12 pr-3">
                            <span className="break-words">{v.title || v.sku || `Variant #${v.id}`}</span>
                            {v.sku && v.title && <span className="ml-2 text-xs text-gray-400">{v.sku}</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right text-gray-500">{fmt(v.currentPrice)}</td>
                          <td className="px-3 py-1.5 text-right">
                            {v.unitCost === null ? (
                              <span className="text-gray-300" title="Build this variant in the Final Product tab">—</span>
                            ) : (
                              fmt(v.unitCost)
                            )}
                          </td>
                          <td
                            className={`px-3 py-1.5 text-right font-medium ${
                              vMargin === null ? "text-gray-300" : vMargin < 0 ? "text-red-600" : "text-green-700"
                            }`}
                          >
                            {fmtPct(vMargin)}
                          </td>
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-gray-400">
                  No products match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
