"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

// One request per step (each fits a serverless function's budget; the whole
// pipeline does not). The data pulls run concurrently where dependencies allow,
// then the compute chain runs in order.
const COMPUTE_STEPS = ["calibrate", "monthly-rate", "sku-monthly-rate", "margins"] as const;

// The paginated pulls process one time-boxed batch per request and report
// reachedEnd=false when a backlog remains. Cap how many times one click will
// re-run a step so a huge first-time catch-up can't loop forever - whatever's
// left is picked up by the next click (the cursor persists server-side).
const MAX_RUNS_PER_STEP = 60;

export function SyncButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [runs, setRuns] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // One sync sub-request. Returns the parsed result so callers can see
  // reachedEnd (absent for non-paginated steps, which are single-shot).
  async function oneRun(step: string): Promise<{ reachedEnd?: boolean }> {
    const res = await fetch(`/api/sync/run?step=${step}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error ?? `Sync failed at step "${step}"`);
    setRuns((c) => c + 1);
    return data;
  }

  // Re-run a paginated step until it's caught up (reachedEnd), so one click
  // clears the whole backlog instead of the owner clicking Sync over and over.
  async function runUntilDone(step: string) {
    for (let i = 0; i < MAX_RUNS_PER_STEP; i++) {
      const data = await oneRun(step);
      if (data.reachedEnd !== false) return; // true, or undefined for single-shot steps
    }
  }

  async function handleClick() {
    setStatus("loading");
    setError(null);
    setRuns(0);
    try {
      // Data pulls, run concurrently and each looped until caught up:
      //  - meta is fully independent (writes ad_spend only);
      //  - shopify orders must land first (Khazenly delivery status rides along
      //    on them), then the product catalog backfills their line items.
      // Replaces the old strictly-sequential single run of every step.
      const meta = runUntilDone("meta");
      const shopifyChain = runUntilDone("shopify").then(() => runUntilDone("shopify-products"));
      await Promise.all([meta, shopifyChain]);

      // Compute chain: order matters (sku-monthly-rate falls back to
      // monthly-rate; margins runs last, once every input is settled).
      for (const step of COMPUTE_STEPS) await oneRun(step);

      setStatus("success");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setTimeout(() => setStatus("idle"), 4000);
    }
  }

  const label =
    status === "loading"
      ? `Syncing… (${runs})`
      : status === "success"
        ? "Synced ✓"
        : status === "error"
          ? "Sync failed"
          : "Sync";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={status === "loading"}
      title={error ?? "Pull the latest Shopify (incl. Khazenly delivery status) and Meta data and recompute margins"}
      className={`rounded-md px-3 py-1.5 text-sm font-medium text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {label}
    </button>
  );
}
