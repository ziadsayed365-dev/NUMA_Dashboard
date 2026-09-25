"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProductOption } from "@/lib/reports/per-product";

// What an ad's spend can be pinned to (same picker as the Miraj project):
//   one or more products - ticked products split the spend equally
//   general             - split equally across every active product
// Either way the Subscription only takes a share on days a subscription sold
// (see splitSharedAdSpend in src/lib/reports/per-product.ts).
export type Allocation = { productIds: number[]; isGeneral: boolean };

export const EMPTY_ALLOCATION: Allocation = { productIds: [], isGeneral: false };

export function allocationIsEmpty(a: Allocation): boolean {
  return !a.isGeneral && a.productIds.length === 0;
}

export function describeAllocation(a: Allocation, products: ProductOption[]): string {
  if (a.isGeneral) return "General (all products)";
  const names = a.productIds.map((id) => products.find((p) => p.id === id)?.label ?? `#${id}`);
  return names.length > 0 ? names.join(" + ") : "—";
}

// The request body /api/ad-spend/allocate takes for this allocation.
export function allocationBody(adId: string, a: Allocation): Record<string, unknown> {
  return a.isGeneral ? { adId, isGeneral: true } : { adId, productIds: a.productIds };
}

// Multi-select dropdown over the product list, with a search box pinned to the
// top of the panel.
export function AllocationPicker({
  products,
  value,
  onChange,
  disabled,
  placeholder = "Choose where this spend belongs",
}: {
  products: ProductOption[];
  value: Allocation;
  onChange: (next: Allocation) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Click-away and Escape both close it - a tall panel over a table is easy to
  // lose track of otherwise.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.label.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q));
  }, [products, query]);
  const showGeneral = !query.trim() || "general".includes(query.trim().toLowerCase());

  function toggleGeneral() {
    // General means "everything", so it can't coexist with a narrower pick.
    onChange(value.isGeneral ? EMPTY_ALLOCATION : { productIds: [], isGeneral: true });
  }

  function toggleProduct(id: number) {
    const on = value.productIds.includes(id);
    onChange({ isGeneral: false, productIds: on ? value.productIds.filter((p) => p !== id) : [...value.productIds, id] });
  }

  const summary = allocationIsEmpty(value) ? placeholder : describeAllocation(value, products);
  const splitCount = value.isGeneral ? 0 : value.productIds.length;

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs ${
          allocationIsEmpty(value) ? "border-gray-300 text-gray-400" : "border-gray-400 text-gray-900"
        } bg-white hover:border-gray-500 disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span className="min-w-0 truncate" dir="auto">
          {summary}
        </span>
        <span className="shrink-0 text-gray-400">▾</span>
      </button>

      {splitCount > 1 && (
        <p className="mt-1 text-[11px] text-gray-500">
          Split equally across {splitCount} — {(100 / splitCount).toFixed(splitCount > 2 ? 1 : 0)}% each
        </p>
      )}

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 rounded-md border border-gray-200 bg-white shadow-lg">
          <div className="sticky top-0 border-b border-gray-100 bg-white p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search products…"
              dir="auto"
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-gray-500"
            />
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {showGeneral && (
              <Item
                on={value.isGeneral}
                onClick={toggleGeneral}
                label="General"
                sublabel="split equally across all products (Subscription only on days it sells)"
                strong
              />
            )}
            {filtered.map((p) => (
              <Item
                key={p.id}
                on={value.productIds.includes(p.id)}
                onClick={() => toggleProduct(p.id)}
                label={p.label}
                sublabel={p.sku ? `SKU ${p.sku}` : undefined}
              />
            ))}
            {!showGeneral && filtered.length === 0 && <li className="px-3 py-2 text-xs text-gray-400">No match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function Item({
  on,
  onClick,
  label,
  sublabel,
  strong,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  sublabel?: string;
  strong?: boolean;
}) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50">
        <span
          className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
            on ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300"
          }`}
        >
          {on ? "✓" : ""}
        </span>
        <span className="min-w-0">
          <span className={`block truncate ${strong ? "font-medium text-gray-900" : "text-gray-700"}`} dir="auto">
            {label}
          </span>
          {sublabel && <span className="block text-[11px] text-gray-400">{sublabel}</span>}
        </span>
      </button>
    </li>
  );
}
