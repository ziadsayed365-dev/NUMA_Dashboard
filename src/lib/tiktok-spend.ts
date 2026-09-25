import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday, daysAgo, addDays } from "@/lib/dates";

// TikTok has no usable Marketing API for this account, so spend is entered by
// hand in a daily popup. Each entry is an amount tagged to a product, or
// "General" (productId null) meaning it applies across all products. Stored in
// ad_spend with source='tiktok' so it flows into the P&L TikTok line exactly
// like Meta's synced rows. Allocation is by product_id (Laurel has no model
// groups), matching how Meta ad spend is allocated per product.
export type TikTokEntry = { amount: number; productId: number | null };

const LOOKBACK_DAYS = 14;

// Recent days (last LOOKBACK_DAYS, up to yesterday) that have no TikTok row yet
// — the popup prompts the owner to fill these. Today is excluded (still open).
export async function getMissingTikTokDays(): Promise<string[]> {
  const start = daysAgo(LOOKBACK_DAYS);
  const yesterday = addDays(egyptToday(), -1);

  const rows = await fetchAllRows<{ date: string }>(
    supabase,
    "ad_spend",
    "id, date, source",
    (q) => q.eq("source", "tiktok").gte("date", start).lte("date", yesterday)
  );
  const have = new Set(rows.map((r) => r.date));

  const missing: string[] = [];
  for (let d = start; d <= yesterday; d = addDays(d, 1)) {
    if (!have.has(d)) missing.push(d);
  }
  return missing;
}

// Replaces a day's TikTok rows with the submitted entries (summing any that
// share a product). An empty submission writes a single zero row so the day is
// recorded as "done" and stops being prompted.
export async function saveTikTokSpend(date: string, entries: TikTokEntry[]): Promise<void> {
  await supabase.from("ad_spend").delete().eq("source", "tiktok").eq("date", date);

  const byProduct = new Map<string, { productId: number | null; amount: number }>();
  for (const e of entries) {
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = e.productId == null ? "general" : String(e.productId);
    const cur = byProduct.get(key) ?? { productId: e.productId ?? null, amount: 0 };
    cur.amount += amount;
    byProduct.set(key, cur);
  }

  const now = new Date().toISOString();
  const rows =
    byProduct.size === 0
      ? [{ date, source: "tiktok", ad_id: "tiktok:none", ad_name: "TikTok (no spend)", adset_name: "TikTok", product_id: null, spend: 0, currency: "EGP", synced_at: now }]
      : [...byProduct.entries()].map(([key, v]) => {
          const id = `tiktok:${key}`;
          return {
            date,
            source: "tiktok",
            ad_id: id,
            ad_name: v.productId == null ? "TikTok - General" : `TikTok - Product ${v.productId}`,
            adset_name: "TikTok",
            product_id: v.productId,
            spend: v.amount,
            currency: "EGP",
            synced_at: now,
          };
        });

  const { error } = await supabase.from("ad_spend").upsert(rows, { onConflict: "date,source,ad_id" });
  if (error) throw new Error(`Failed to save TikTok spend: ${error.message}`);
}
