"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { UnmappedAd } from "@/lib/reports/ad-allocation";
import type { AdProductSuggestion } from "@/lib/reports/ad-product-suggestion";
import type { ProductOption } from "@/lib/reports/per-product";
import {
  AllocationPicker,
  EMPTY_ALLOCATION,
  allocationBody,
  allocationIsEmpty,
  describeAllocation,
  type Allocation,
} from "./allocation-picker";

export function AdAllocationModal({ ads, products }: { ads: UnmappedAd[]; products: ProductOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  // Ads already handled (allocated or skipped) this session - removed from view
  // locally so you can blow through the list without a reload between each.
  const [done, setDone] = useState<Set<string>>(new Set());
  const [changed, setChanged] = useState(false);
  // The most recent allocation, kept so it can be undone with one click. Only the
  // last one is undoable - each new allocation replaces it.
  const [lastAllocated, setLastAllocated] = useState<{ ad: UnmappedAd; label: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const visible = ads.filter((a) => !done.has(a.adId));
  const suggestions = useAdSuggestions(open ? ads : []);

  // Refresh the per-product tables behind the modal ONCE, when finished - not
  // after every allocation. Each allocation used to trigger router.refresh(),
  // which re-runs both heavy per-product reports before you could touch the next
  // ad; now the refresh happens a single time on close.
  function finish() {
    setOpen(false);
    if (changed) router.refresh();
  }

  function handleAllocated(ad: UnmappedAd, label: string) {
    setChanged(true);
    setDone((s) => new Set(s).add(ad.adId));
    setLastAllocated({ ad, label });
    setUndoError(null);
  }

  function skip(adId: string) {
    setDone((s) => new Set(s).add(adId));
  }

  // Reverse the last allocation: un-allocate it in the DB and drop it back into
  // the list so it can be re-done (or left for later).
  async function undoLast() {
    if (!lastAllocated) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const res = await fetch("/api/ad-spend/allocate", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adId: lastAllocated.ad.adId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to undo");
      setDone((s) => {
        const next = new Set(s);
        next.delete(lastAllocated.ad.adId);
        return next;
      });
      setLastAllocated(null);
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : "Failed to undo");
    } finally {
      setUndoing(false);
    }
  }

  if (!open || ads.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-red-700">
            New ads need a product
            <span className="ml-2 text-xs font-normal text-gray-400">{visible.length} left</span>
          </h2>
          <button type="button" onClick={finish} aria-label="Close" className="shrink-0 text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>
        <p className="mt-2 text-sm text-gray-600">
          These Meta ads have spend that isn&apos;t allocated to any product yet, so they&apos;re missing from the per-product
          marketing spend figures. Tick a product for each, several to split it equally between them, or General to split it
          equally across all products. The Subscription only takes a share on days a subscription sold. It&apos;ll apply to all of that ad&apos;s spend, past and future.
        </p>

        {visible.length > 0 ? (
          <ul className="mt-3 max-h-96 space-y-3 overflow-y-auto overflow-x-hidden">
            {visible.map((ad) => (
              <AdRow
                key={ad.adId}
                ad={ad}
                products={products}
                suggestion={suggestions.byAd[ad.adId] ?? null}
                suggestionsLoading={suggestions.loading}
                onAllocated={(label) => handleAllocated(ad, label)}
                onSkip={() => skip(ad.adId)}
              />
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-md bg-gray-50 px-3 py-3 text-sm text-gray-500">All ads handled.</p>
        )}

        {/* Undo bar for the last allocation - one level of undo. */}
        {lastAllocated && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
            <span className="min-w-0 truncate text-gray-600">
              Allocated <span className="font-medium text-gray-900">{lastAllocated.ad.adName ?? lastAllocated.ad.adId}</span> →{" "}
              <span className="font-medium text-gray-900">{lastAllocated.label}</span>
            </span>
            <button
              type="button"
              onClick={undoLast}
              disabled={undoing}
              className="shrink-0 font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
            >
              {undoing ? "Undoing…" : "Undo"}
            </button>
          </div>
        )}
        {undoError && <p className="mt-1 text-xs text-red-600">{undoError}</p>}

        <div className="mt-4 flex justify-end border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={finish}
            className="rounded bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Asks Meta what each ad links to, so the row can name the product the ad is
 * actually selling - the ad and campaign names on their own often don't say.
 * Runs after the popup is on screen; the rows are usable while it's in flight.
 */
function useAdSuggestions(ads: UnmappedAd[]): { byAd: Record<string, AdProductSuggestion>; loading: boolean } {
  const [byAd, setByAd] = useState<Record<string, AdProductSuggestion>>({});
  const [loading, setLoading] = useState(false);
  // Depend on the ids themselves, not the array identity, so a refresh that
  // returns the same ads doesn't re-hit Meta.
  const key = ads.map((ad) => ad.adId).join(",");

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/ad-spend/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adIds: key.split(",") }),
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) return;
        setByAd((current) => {
          const next = { ...current };
          for (const suggestion of data.suggestions as AdProductSuggestion[]) next[suggestion.adId] = suggestion;
          return next;
        });
      })
      // A failed lookup just means no suggestion - allocating by hand still works.
      .catch(() => {})
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [key]);

  return { byAd, loading };
}

function AdRow({
  ad,
  products,
  suggestion,
  suggestionsLoading,
  onAllocated,
  onSkip,
}: {
  ad: UnmappedAd;
  products: ProductOption[];
  suggestion: AdProductSuggestion | null;
  suggestionsLoading: boolean;
  onAllocated: (label: string) => void;
  onSkip: () => void;
}) {
  const [allocation, setAllocation] = useState<Allocation>(EMPTY_ALLOCATION);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only an outright name match is filled in for the owner; a word-overlap
  // guess is shown as text and left for them to confirm, so a near-miss can't
  // be allocated by simply clicking through.
  const suggestedId = suggestion?.exact ? suggestion.productId : null;
  useEffect(() => {
    if (suggestedId !== null && !touched) setAllocation({ productIds: [suggestedId], isGeneral: false });
  }, [suggestedId, touched]);

  async function allocate(target: Allocation) {
    if (allocationIsEmpty(target)) {
      setError("Pick a product first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/ad-spend/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(allocationBody(ad.adId, target)),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to allocate");
      // Row done - drop it from the list locally, no page reload. The tables
      // behind refresh once when the modal closes.
      onAllocated(describeAllocation(target, products));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to allocate");
      setSubmitting(false); // keep the row so it can be retried
    }
  }

  // Campaign › ad set context helps identify which product an ad promotes.
  const context = [ad.campaignName, ad.adsetName].filter(Boolean).join(" › ");

  return (
    <li className="rounded-md border border-gray-200 p-3 text-sm">
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-gray-900">{ad.adName ?? "(unnamed ad)"}</p>
          {context && <p className="truncate text-xs text-gray-500">{context}</p>}
          <p className="truncate text-xs text-gray-400">Ad ID: {ad.adId}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-medium text-gray-900">{ad.spend.toLocaleString("en-US", { maximumFractionDigits: 0 })} EGP</p>
          <p className="text-xs text-gray-400">through {ad.date}</p>
        </div>
      </div>
      <SuggestionLine suggestion={suggestion} loading={suggestionsLoading} />
      <div className="mt-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <AllocationPicker
            products={products}
            value={allocation}
            disabled={submitting}
            placeholder="Select a product…"
            onChange={(next) => {
              setTouched(true);
              setAllocation(next);
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => allocate(allocation)}
          disabled={submitting}
          className="rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "…" : "Allocate"}
        </button>
        <button type="button" onClick={onSkip} disabled={submitting} className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-60">
          Skip
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

function SuggestionLine({ suggestion, loading }: { suggestion: AdProductSuggestion | null; loading: boolean }) {
  if (!suggestion) {
    return loading ? <p className="mt-2 text-xs text-gray-400">Checking where this ad links to…</p> : null;
  }

  const { url, handle, productLabel, modelName, exact } = suggestion;

  return (
    <div className="mt-2 text-xs">
      {productLabel ? (
        <p className={exact ? "text-emerald-700" : "text-amber-700"}>
          {exact ? "Links to" : "Looks like"} <span className="font-medium">{productLabel}</span>
          {exact ? " (pre-selected)" : " — confirm before allocating"}
        </p>
      ) : modelName ? (
        <p className="text-amber-700">
          Links to model <span className="font-medium">{modelName}</span>, which has several products — pick the right one.
        </p>
      ) : handle ? (
        <p className="text-gray-500">
          Links to <span className="font-medium">{handle}</span>, which doesn&apos;t match any product.
        </p>
      ) : (
        <p className="text-gray-400">No product page found in this ad&apos;s link.</p>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 block truncate text-gray-400 underline decoration-dotted hover:text-gray-600"
        >
          {url}
        </a>
      )}
    </div>
  );
}
