import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { addDays } from "@/lib/dates";
import { getBuiltCostByProduct } from "@/lib/products/final-products";
import { getAdProductSuggestions } from "./ad-product-suggestion";
import { getDailyPnl } from "./daily-pnl";
import { getPerProductReport } from "./per-product";
import { getDayComparison, type DayComparison } from "./day-comparison";

// The nightly audit AI NUMA reads after its sync (GET /api/agent/audit). It
// answers the owner's questions - was TikTok spend entered for the day, is there
// Meta spend nobody has allocated to a product, and was anything sold with no
// Product List cost (BOM) - and checks that the Income Statement and Analysis
// by Product agree for the day being reported.

// The day AI NUMA started. The owner wants it to police new numbers only, so
// sales, ad spend and TikTok days before this are never flagged.
const AUDIT_SINCE = "2026-09-25";

// The owner only wants to hear about a big gap between the two reports: 5,000
// EGP or more on a line. Anything smaller is ignored.
const TIE_FLAG_AT_EGP = 5000;

export type UnallocatedAd = {
  adId: string;
  adName: string | null;
  campaignName: string | null;
  adsetName: string | null;
  lastDay: string; // most recent day it spent with no product
  lastDaySpend: number;
  totalSpend: number; // since AUDIT_SINCE, up to the reported day
  // The product its landing page points at, when the catalog has one by that
  // name (the same hint the allocation popup shows). Never applied on its own.
  suggestedProduct: string | null;
  landingUrl: string | null;
};

export type MissingCostProduct = {
  productId: number;
  name: string;
  sku: string | null;
  isBundle: boolean;
  unitsSold: number;
  lastSoldDay: string;
};

export type TieLine = { incomeStatement: number; byProduct: number; difference: number; ok: boolean };

export type TieCheck = {
  mode: "performance" | "actual";
  revenue: TieLine;
  cogs: TieLine;
  adSpend: TieLine;
};

export type NightlyAudit = {
  ok: boolean;
  day: string;
  // Days (up to and including `day`) with no TikTok entry yet - the same days
  // the dashboard's TikTok popup would ask for.
  tiktokMissingDays: string[];
  tiktokSpend: number; // what was entered for `day` (0 when missing)
  unallocatedAds: UnallocatedAd[];
  missingCostProducts: MissingCostProduct[];
  ties: TieCheck[];
  // The day against an average day, for the short analysis in the nightly message.
  comparison: DayComparison;
  // Every product the owner can name in a reply, so an answer can be matched
  // exactly rather than guessed. Active ones are those General spend is split over.
  products: { id: number; name: string; active: boolean }[];
};

function tieLine(incomeStatement: number, byProduct: number): TieLine {
  const difference = incomeStatement - byProduct;
  return { incomeStatement, byProduct, difference, ok: Math.abs(difference) < TIE_FLAG_AT_EGP };
}

async function getTikTok(day: string): Promise<{ missingDays: string[]; spend: number }> {
  // From the earlier of the two, so the day's own spend is read even when it
  // is before AUDIT_SINCE (a re-run for an older day); only missing days are
  // limited to AUDIT_SINCE.
  const from = day < AUDIT_SINCE ? day : AUDIT_SINCE;
  const rows = await fetchAllRows<{ date: string; spend: number }>(supabase, "ad_spend", "id, date, spend", (q) =>
    q.eq("source", "tiktok").gte("date", from).lte("date", day)
  );
  const have = new Set(rows.map((r) => r.date));
  const missingDays: string[] = [];
  for (let d = AUDIT_SINCE; d <= day; d = addDays(d, 1)) {
    if (!have.has(d)) missingDays.push(d);
  }
  const spend = rows.filter((r) => r.date === day).reduce((sum, r) => sum + Number(r.spend), 0);
  return { missingDays, spend };
}

// Meta spend with no product and no allocation decision (the popup's list, read
// fresh rather than through its cache so an allocation made a minute ago is
// already gone). Also returns the reported day's unallocated total, which
// Analysis by Product leaves out and the Income Statement keeps.
async function getUnallocated(day: string): Promise<{ ads: UnallocatedAd[]; daySpend: number }> {
  const { data: assigned, error } = await supabase.from("ad_assignments").select("ad_id");
  if (error) throw new Error(`Failed to load ad assignments: ${error.message}`);
  const assignedIds = new Set((assigned ?? []).map((a) => a.ad_id as string));

  const from = day < AUDIT_SINCE ? day : AUDIT_SINCE;
  const rows = await fetchAllRows<{
    ad_id: string | null;
    ad_name: string | null;
    campaign_name: string | null;
    adset_name: string | null;
    date: string;
    spend: number;
  }>(supabase, "ad_spend", "id, ad_id, ad_name, campaign_name, adset_name, date, spend", (q) =>
    q.is("product_id", null).neq("source", "tiktok").gte("date", from).lte("date", day)
  );

  let daySpend = 0;
  const byAd = new Map<string, Omit<UnallocatedAd, "suggestedProduct" | "landingUrl">>();
  for (const r of rows) {
    if (!r.ad_id || assignedIds.has(r.ad_id)) continue;
    const spend = Number(r.spend);
    if (r.date === day) daySpend += spend;
    if (r.date < AUDIT_SINCE || spend === 0) continue;
    const ad = byAd.get(r.ad_id);
    if (!ad) {
      byAd.set(r.ad_id, {
        adId: r.ad_id,
        adName: r.ad_name,
        campaignName: r.campaign_name,
        adsetName: r.adset_name,
        lastDay: r.date,
        lastDaySpend: spend,
        totalSpend: spend,
      });
      continue;
    }
    ad.totalSpend += spend;
    if (r.date > ad.lastDay) {
      ad.lastDay = r.date;
      ad.lastDaySpend = spend;
    } else if (r.date === ad.lastDay) {
      ad.lastDaySpend += spend;
    }
    ad.adName ??= r.ad_name;
    ad.campaignName ??= r.campaign_name;
    ad.adsetName ??= r.adset_name;
  }

  // A hint only - Meta being slow or down must not cost the owner the audit.
  const suggestions = await getAdProductSuggestions([...byAd.keys()]).catch(() => []);
  const suggestionByAd = new Map(suggestions.map((s) => [s.adId, s]));
  const ads = [...byAd.values()]
    .map((ad) => {
      const s = suggestionByAd.get(ad.adId);
      return { ...ad, suggestedProduct: s?.productLabel ?? null, landingUrl: s?.url ?? null };
    })
    .sort((a, b) => b.totalSpend - a.totalSpend);
  return { ads, daySpend };
}

// Same rule Analysis by Product flags "no cost" on (costMissing in
// per-product.ts): a product sold with no Product List BOM is costed at zero.
async function getMissingCostProducts(day: string): Promise<MissingCostProduct[]> {
  const builtCost = await getBuiltCostByProduct();
  const { data: products, error } = await supabase.from("products").select("id, name, sku, is_bundle");
  if (error) throw new Error(`Failed to load products: ${error.message}`);
  const productById = new Map((products ?? []).map((p) => [p.id as number, p]));

  const lineItems = await fetchAllRows<{
    product_id: number | null;
    quantity: number;
    orders: { egypt_day: string; cancelled_at: string | null } | null;
  }>(supabase, "order_line_items", "id, product_id, quantity, orders!inner(egypt_day, cancelled_at)", (q) =>
    q.gte("orders.egypt_day", AUDIT_SINCE).lte("orders.egypt_day", day)
  );

  const byProduct = new Map<number, MissingCostProduct>();
  for (const li of lineItems) {
    const soldDay = li.orders?.egypt_day;
    if (!li.product_id || !soldDay || li.orders?.cancelled_at) continue;
    if (builtCost.has(li.product_id)) continue;
    const product = productById.get(li.product_id);
    if (!product) continue;

    const existing = byProduct.get(product.id);
    if (existing) {
      existing.unitsSold += li.quantity ?? 0;
      if (soldDay > existing.lastSoldDay) existing.lastSoldDay = soldDay;
      continue;
    }
    byProduct.set(product.id, {
      productId: product.id,
      name: product.name,
      sku: product.sku ?? null,
      isBundle: product.is_bundle ?? false,
      unitsSold: li.quantity ?? 0,
      lastSoldDay: soldDay,
    });
  }

  return [...byProduct.values()].sort((a, b) => (a.lastSoldDay < b.lastSoldDay ? 1 : -1));
}

async function tieCheck(day: string, mode: "performance" | "actual", unallocatedDaySpend: number): Promise<TieCheck> {
  const pnl = await getDailyPnl(day, day, mode);
  const row = pnl.rows.find((r) => r.date === day);
  const { products } = await getPerProductReport(day, day, mode);

  const sum = (pick: (p: (typeof products)[number]) => number) => products.reduce((acc, p) => acc + pick(p), 0);
  return {
    mode,
    revenue: tieLine(row?.revenue ?? 0, sum((p) => p.revenue)),
    cogs: tieLine(row?.cogs ?? 0, sum((p) => p.cogs)),
    // Analysis by Product leaves unallocated Meta spend out of every product;
    // the Income Statement's marketing line keeps it. Add it back so only a real
    // disagreement shows (the unallocated ads are reported on their own).
    adSpend: tieLine(row?.adSpend ?? 0, sum((p) => p.adSpend) + unallocatedDaySpend),
  };
}

export async function runNightlyAudit(day: string): Promise<NightlyAudit> {
  const [tiktok, unallocated, missingCostProducts, comparison, productsRes] = await Promise.all([
    getTikTok(day),
    getUnallocated(day),
    getMissingCostProducts(day),
    getDayComparison(day),
    supabase.from("products").select("id, name, status").order("name"),
  ]);
  if (productsRes.error) throw new Error(`Failed to load products: ${productsRes.error.message}`);

  // Performance only, the mode the nightly PDF prints. Actual counts only orders
  // handed to the courier, so the day just reported has almost none and the two
  // reports split its ad spend differently - a gap that is not in the PDF.
  const ties = [await tieCheck(day, "performance", unallocated.daySpend)];
  const tiesOk = ties.every((t) => t.revenue.ok && t.cogs.ok && t.adSpend.ok);

  return {
    ok: tiktok.missingDays.length === 0 && unallocated.ads.length === 0 && missingCostProducts.length === 0 && tiesOk,
    day,
    tiktokMissingDays: tiktok.missingDays,
    tiktokSpend: tiktok.spend,
    unallocatedAds: unallocated.ads,
    missingCostProducts,
    ties,
    comparison,
    products: (productsRes.data ?? []).map((p) => ({
      id: p.id as number,
      name: p.name as string,
      active: !p.status || String(p.status).toUpperCase() === "ACTIVE",
    })),
  };
}
