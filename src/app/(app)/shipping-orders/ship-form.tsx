"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { courierLabel, parseOrderNumbers, type BulkRecordSummary, type ShipperSummary } from "@/lib/shipping/shared";

// Returns are the one thing recorded by hand - which orders shipped, and
// whether Khazenly delivered them, arrives with the Shopify sync. So there is no
// courier to pick (Khazenly is the only one) and no date (each return is dated
// by the day its own order shipped).
export function ReturnsForm({ summaries, canEdit }: { summaries: ShipperSummary[]; canEdit: boolean }) {
  const router = useRouter();

  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkRecordSummary | null>(null);

  const parsedCount = parseOrderNumbers(raw).length;

  async function handleSubmit() {
    const numbers = parseOrderNumbers(raw);
    if (numbers.length === 0) {
      setError("Paste at least one order number.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/shipping/returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courier: "khazenly", numbers }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to record returns");
      setResult(data.summary as BulkRecordSummary);
      setRaw("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "rounded border border-gray-300 px-2 py-1 text-sm";

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium uppercase text-gray-400">
            Returned order numbers — paste one per line (or comma-separated)
          </span>
          <textarea
            className={`${inputClass} h-48 font-mono disabled:bg-gray-50 disabled:text-gray-400`}
            placeholder={"1622\n#1623\n1630\n…"}
            value={raw}
            disabled={!canEdit}
            onChange={(e) => setRaw(e.target.value)}
          />
        </label>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            disabled={busy || parsedCount === 0 || !canEdit}
            onClick={handleSubmit}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : `Mark ${parsedCount} order${parsedCount === 1 ? "" : "s"} returned`}
          </button>
          <span className="text-xs text-gray-400">
            {canEdit ? `${parsedCount} number${parsedCount === 1 ? "" : "s"} ready` : "Read-only — ask the owner for upload access"}
          </span>
        </div>
        <p className="mt-2 text-xs text-gray-400">Each return is dated by the day its order shipped. Run Sync afterward to refresh the P&amp;L.</p>
      </div>

      {error && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {result && <ResultCard result={result} />}

      <SummaryTable summaries={summaries} />
    </div>
  );
}

function ResultCard({ result }: { result: BulkRecordSummary }) {
  return (
    <div className="space-y-3 rounded-lg border border-green-300 bg-green-50 p-4 text-sm">
      <p className="font-medium text-green-800">
        Recorded {result.matched} return{result.matched === 1 ? "" : "s"}, each dated by the day its order shipped.
      </p>
      <ul className="space-y-1 text-gray-700">
        <li>Requested: {result.requested}</li>
        <li>Matched &amp; updated: {result.matched}</li>
        {result.alreadyRecorded > 0 && <li>Already recorded as returned: {result.alreadyRecorded}</li>}
        {result.cancelled.length > 0 && <li className="text-amber-700">Skipped (cancelled): {result.cancelled.length}</li>}
        {result.notShipped.length > 0 && (
          <li className="text-amber-700">Not recorded (no Khazenly fulfillment in Shopify): {result.notShipped.length}</li>
        )}
        {result.notFound.length > 0 && <li className="text-red-700">Not found: {result.notFound.length}</li>}
      </ul>
      <Details label="order(s) never shipped" items={result.notShipped} tone="amber" />
      <Details label="order number(s) with no match" items={result.notFound} tone="red" />
      <Details label="cancelled order number(s)" items={result.cancelled} tone="amber" />
    </div>
  );
}

function Details({ label, items, tone }: { label: string; items: string[]; tone: "red" | "amber" }) {
  if (items.length === 0) return null;
  const cls = tone === "red" ? "text-red-700" : "text-amber-700";
  return (
    <details className={`text-xs ${cls}`}>
      <summary className="cursor-pointer">
        Show {items.length} {label}
      </summary>
      <p className="mt-1 break-all font-mono">{items.join(", ")}</p>
    </details>
  );
}

function SummaryTable({ summaries }: { summaries: ShipperSummary[] }) {
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr className="text-left text-xs font-medium uppercase text-gray-400">
              <th className="px-3 py-1.5">Shipper</th>
              <th className="px-3 py-1.5 text-right">Shipped</th>
              <th className="px-3 py-1.5 text-right">Delivered</th>
              <th className="px-3 py-1.5 text-right">Returned</th>
              <th className="px-3 py-1.5 text-right">Deliv. rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {summaries.map((s) => (
              <tr key={s.courier}>
                <td className="px-3 py-1.5 text-gray-700">{courierLabel(s.courier)}</td>
                <td className="px-3 py-1.5 text-right font-semibold text-gray-900">{s.orders.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right font-semibold text-gray-900">{s.delivered.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right font-semibold text-gray-900">{s.returned.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right font-semibold text-gray-900">
                  {s.deliveryRate === null ? "—" : `${(s.deliveryRate * 100).toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-3 pt-1 text-xs text-gray-400">
        Delivered comes from Khazenly&apos;s status on the Shopify fulfillment; returned is Khazenly&apos;s &quot;not delivered&quot;
        plus the returns uploaded here. Rate = delivered ÷ (delivered + returned) — parcels still on the road are left out.
      </p>
    </div>
  );
}
