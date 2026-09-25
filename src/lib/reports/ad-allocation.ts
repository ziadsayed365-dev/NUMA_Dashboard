import "server-only";
import { unstable_cache } from "next/cache";
import { REPORT_CACHE_SECONDS, REPORT_CACHE_TAG } from "./cache";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";

export type UnmappedAd = {
  adId: string;
  adName: string | null;
  campaignName: string | null;
  adsetName: string | null;
  date: string; // most recent day this ad still has unallocated spend
  spend: number; // total unallocated spend for the ad since the backlog cutoff
};

// One-time reset point: there was a large pre-existing backlog of unmapped ad
// spend from before this popup existed, not worth allocating retroactively.
// Only ad spend from this date forward counts as "new" and gets flagged.
const BACKLOG_CUTOFF = "2026-06-20";

// Ads with spend not yet allocated to a product, so they're missing from the
// per-product marketing figures. Keyed by ad_id - each new ad needs its own
// allocation decision, and allocating it (POST /api/ad-spend/allocate) applies
// to every day for that ad, past and future. The running total (not one day) is
// shown, so the owner can prioritise the biggest spenders.
//
// TikTok "General" spend (source='tiktok', product_id null) is deliberately
// left unallocated - it isn't tied to one product, so it's excluded here and
// instead split equally across every product in the per-product report
// (see getPerProductReport). Only Meta ads genuinely need a per-product choice.
//
// An ad the owner has already handled - allocated to a product, or marked
// "General" (an ad_assignments row with a null product_id) - is excluded too.
// A General ad keeps product_id null in ad_spend, so its assignment row is the
// only thing that tells it apart from a still-unallocated ad; without this it
// would reappear in the popup forever.
// Paginates every unallocated ad_spend row, which is thousands of rows on a
// mature account - and it ran on every Analysis by Product load. Dropped by the
// allocation write below, so allocating an ad still updates the popup at once.
export const getUnmappedAds = unstable_cache(computeUnmappedAds, ["unmapped-ads"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

async function computeUnmappedAds(): Promise<UnmappedAd[]> {
  const { data: assigned, error: assignedErr } = await supabase.from("ad_assignments").select("ad_id");
  if (assignedErr) throw new Error(`Failed to load ad assignments: ${assignedErr.message}`);
  const assignedIds = new Set((assigned ?? []).map((a) => a.ad_id as string));

  const rows = await fetchAllRows<{
    ad_id: string | null;
    ad_name: string | null;
    campaign_name: string | null;
    adset_name: string | null;
    date: string;
    spend: number;
  }>(
    supabase,
    "ad_spend",
    "ad_id, ad_name, campaign_name, adset_name, date, spend",
    (query) => query.is("product_id", null).neq("source", "tiktok").gte("date", BACKLOG_CUTOFF)
  );

  const byAd = new Map<string, UnmappedAd>();
  for (const row of rows) {
    if (!row.ad_id || assignedIds.has(row.ad_id)) continue;
    const existing = byAd.get(row.ad_id);
    if (!existing) {
      byAd.set(row.ad_id, {
        adId: row.ad_id,
        adName: row.ad_name,
        campaignName: row.campaign_name,
        adsetName: row.adset_name,
        date: row.date,
        spend: Number(row.spend),
      });
    } else {
      existing.spend += Number(row.spend);
      if (row.date > existing.date) existing.date = row.date;
      if (!existing.adName && row.ad_name) existing.adName = row.ad_name;
      if (!existing.campaignName && row.campaign_name) existing.campaignName = row.campaign_name;
      if (!existing.adsetName && row.adset_name) existing.adsetName = row.adset_name;
    }
  }

  return [...byAd.values()].sort((a, b) => b.spend - a.spend);
}

// One ad the owner has already allocated - shown in the Settings management view
// so an allocation can be reviewed and changed after the fact. productIds empty =
// "General (all products)"; one id = that product; several = split equally
// across them. Metadata + total spend are rolled up from every ad_spend day.
export type AdAllocation = {
  adId: string;
  adName: string | null;
  campaignName: string | null;
  adsetName: string | null;
  source: string | null;
  spend: number; // total spend across every day on record for the ad
  // Per-day spend, so Settings can re-total the ad over any date range without a
  // round trip. Only a few thousand rows exist across every allocated ad, which
  // is well worth sending once for an instant filter.
  daily: { date: string; spend: number }[];
  lastDate: string; // most recent day with spend (empty if none on record)
  productIds: number[]; // empty = General
  productNames: string[]; // same order as productIds
};

// Every ad that has an assignment (allocated to a product, or marked General),
// enriched with its name/campaign/spend for display in Settings. Excludes
// still-unallocated ads (those have no assignment row and live in the popup).
export async function getAdAllocations(): Promise<AdAllocation[]> {
  const { data: assignments, error } = await supabase.from("ad_assignments").select("ad_id, product_id, product_ids");
  if (error) throw new Error(`Failed to load ad assignments: ${error.message}`);
  const assigned = (assignments ?? []) as { ad_id: string; product_id: number | null; product_ids: number[] | null }[];
  if (assigned.length === 0) return [];

  const { data: products, error: prodErr } = await supabase.from("products").select("id, name");
  if (prodErr) throw new Error(`Failed to load products: ${prodErr.message}`);
  const productName = new Map((products ?? []).map((p) => [p.id, p.name as string]));
  // One product, several, or none (General) - see migration 0081.
  const idsOf = (a: { product_id: number | null; product_ids: number[] | null }): number[] =>
    a.product_id != null ? [a.product_id] : (a.product_ids ?? []).map(Number);
  const productIdsByAd = new Map(assigned.map((a) => [a.ad_id, idsOf(a)]));

  const rows = await fetchAllRows<{
    ad_id: string | null;
    ad_name: string | null;
    campaign_name: string | null;
    adset_name: string | null;
    source: string | null;
    date: string;
    spend: number;
  }>(
    supabase,
    "ad_spend",
    "id, ad_id, ad_name, campaign_name, adset_name, source, date, spend",
    (query) => query.in("ad_id", assigned.map((a) => a.ad_id))
  );

  const namesFor = (ids: number[]) => ids.map((pid) => productName.get(pid) ?? `#${pid}`);

  const byAd = new Map<string, AdAllocation>();
  for (const row of rows) {
    if (!row.ad_id) continue;
    const existing = byAd.get(row.ad_id);
    if (!existing) {
      const ids = productIdsByAd.get(row.ad_id) ?? [];
      byAd.set(row.ad_id, {
        adId: row.ad_id,
        adName: row.ad_name,
        campaignName: row.campaign_name,
        adsetName: row.adset_name,
        source: row.source,
        spend: Number(row.spend),
        daily: [{ date: row.date, spend: Number(row.spend) }],
        lastDate: row.date,
        productIds: ids,
        productNames: namesFor(ids),
      });
    } else {
      existing.spend += Number(row.spend);
      existing.daily.push({ date: row.date, spend: Number(row.spend) });
      if (row.date > existing.lastDate) existing.lastDate = row.date;
      if (!existing.adName && row.ad_name) existing.adName = row.ad_name;
      if (!existing.campaignName && row.campaign_name) existing.campaignName = row.campaign_name;
      if (!existing.adsetName && row.adset_name) existing.adsetName = row.adset_name;
      if (!existing.source && row.source) existing.source = row.source;
    }
  }

  // An assignment whose ad has no ad_spend rows left still shows (spend 0), so it
  // can be corrected or removed rather than being invisible.
  for (const a of assigned) {
    if (byAd.has(a.ad_id)) continue;
    byAd.set(a.ad_id, {
      adId: a.ad_id,
      adName: null,
      campaignName: null,
      adsetName: null,
      source: null,
      spend: 0,
      daily: [],
      lastDate: "",
      productIds: idsOf(a),
      productNames: namesFor(idsOf(a)),
    });
  }

  return [...byAd.values()].sort((a, b) => b.spend - a.spend);
}
