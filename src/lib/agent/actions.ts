import "server-only";
import { supabase } from "@/lib/supabase";
import { saveTikTokSpend } from "@/lib/tiktok-spend";

// The only changes AI NUMA may make to the dashboard, applied when the owner
// answers a nightly message (POST /api/agent/apply). Each one is the same edit
// the owner would make by hand - enter a day's TikTok spend in the popup, or
// allocate an ad in the allocation popup - and nothing here can overwrite an
// existing decision: a TikTok day already entered or an ad already allocated is
// reported back instead of being changed. Product names are matched exactly
// (ignoring case and spacing) so a vague answer fails loudly rather than
// allocating to the wrong product.
//
// There is deliberately no "set cost" action: NUMA's cost is a Product List BOM
// (components x quantities), which a one-line Telegram reply can't describe
// safely. The agent reports missing costs and the owner enters them.

export type AgentAction =
  | { type: "set_tiktok_spend"; date: string; amount: number }
  | { type: "allocate_ad"; adId: string; productNames: string[]; general: boolean };

export type ActionResult = { action: AgentAction; ok: boolean; detail: string };

function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

async function findProducts(names: string[]): Promise<{ id: number; name: string }[]> {
  const { data, error } = await supabase.from("products").select("id, name");
  if (error) throw new Error(`Failed to load products: ${error.message}`);
  const all = (data ?? []) as { id: number; name: string }[];
  const found = new Map<number, { id: number; name: string }>();
  for (const wanted of names) {
    const matches = all.filter((p) => normalize(p.name) === normalize(wanted));
    if (matches.length > 1) throw new Error(`"${wanted}" matches ${matches.length} products - be more specific`);
    if (matches.length === 0) {
      throw new Error(`No product called "${wanted}". Known products: ${all.map((p) => p.name).join(", ")}`);
    }
    found.set(matches[0].id, matches[0]);
  }
  return [...found.values()];
}

// Exactly what the popup saves for one amount under "General (all products)",
// or its "No spend this day" button for 0.
async function setTikTokSpend(date: string, amount: number): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date`);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`"${amount}" is not a valid amount`);

  const { data: existing, error } = await supabase
    .from("ad_spend")
    .select("spend")
    .eq("source", "tiktok")
    .eq("date", date);
  if (error) throw new Error(`Failed to check TikTok spend: ${error.message}`);
  if ((existing ?? []).length > 0) {
    const total = (existing ?? []).reduce((sum, r) => sum + Number(r.spend), 0);
    throw new Error(`TikTok spend for ${date} is already entered (${total} EGP) - change it on the dashboard`);
  }

  await saveTikTokSpend(date, amount > 0 ? [{ amount, productId: null }] : []);
  return amount > 0 ? `TikTok spend for ${date} recorded: ${amount} EGP (General)` : `TikTok spend for ${date} recorded as none`;
}

// The same writes as the allocation popup (POST /api/ad-spend/allocate): one
// product is stamped straight onto the spend, several (or General) leave it
// null and are split at read time by splitSharedAdSpend.
async function allocateAd(adId: string, productNames: string[], general: boolean): Promise<string> {
  const products = general ? [] : await findProducts(productNames);
  if (!general && products.length === 0) throw new Error("Name at least one product, or say it is General");

  const { data: existing, error: existingErr } = await supabase
    .from("ad_assignments")
    .select("ad_id")
    .eq("ad_id", adId)
    .maybeSingle();
  if (existingErr) throw new Error(`Failed to check the ad: ${existingErr.message}`);
  if (existing) throw new Error(`Ad ${adId} is already allocated - change it in Settings > Ad Allocation`);

  const { count, error: spendCheckErr } = await supabase
    .from("ad_spend")
    .select("id", { count: "exact", head: true })
    .eq("ad_id", adId);
  if (spendCheckErr) throw new Error(`Failed to check the ad's spend: ${spendCheckErr.message}`);
  if (!count) throw new Error(`No spend on record for ad ${adId}`);

  const productId = products.length === 1 ? products[0].id : null;
  const productIds = products.length > 1 ? products.map((p) => p.id) : null;

  const { error: assignErr } = await supabase
    .from("ad_assignments")
    .upsert(
      { ad_id: adId, product_id: productId, product_ids: productIds, updated_at: new Date().toISOString() },
      { onConflict: "ad_id" }
    );
  if (assignErr) throw new Error(`Failed to save the allocation: ${assignErr.message}`);

  const { error: spendErr } = await supabase.from("ad_spend").update({ product_id: productId }).eq("ad_id", adId);
  if (spendErr) throw new Error(`Failed to allocate its spend: ${spendErr.message}`);

  const target = general ? "General (all products)" : products.map((p) => p.name).join(", ");
  return `Ad ${adId} allocated to ${target}`;
}

export async function applyAgentActions(actions: AgentAction[]): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of actions) {
    try {
      let detail: string;
      switch (action.type) {
        case "set_tiktok_spend":
          detail = await setTikTokSpend(action.date, action.amount);
          break;
        case "allocate_ad":
          detail = await allocateAd(action.adId, action.productNames, action.general);
          break;
      }
      results.push({ action, ok: true, detail });
    } catch (err) {
      results.push({ action, ok: false, detail: err instanceof Error ? err.message : "failed" });
    }
  }
  return results;
}
