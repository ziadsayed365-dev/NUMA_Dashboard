import "server-only";

const META_API_VERSION = "v21.0";

// Graph caps a multi-object (?ids=) read at 50 objects per request.
const ID_BATCH_SIZE = 50;

// One ad's spend for one day, tagged with the ad account it came from and the
// full Meta hierarchy (campaign -> ad set -> ad). Laurel allocates spend at the
// AD level, so ad_id is the grain; the campaign/ad-set names are carried for
// grouping and display in the allocation popup. Laurel runs ads across multiple
// ad accounts, so every insight carries its owning accountId for traceability.
export type MetaAdInsight = {
  accountId: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id: string;
  ad_name?: string;
  spend: string;
  date_start: string;
};

// META_AD_ACCOUNT_ID is a comma-separated list of numeric account IDs (no
// "act_" prefix - that's added per-request below).
function getAdAccountIds(): string[] {
  const raw = process.env.META_AD_ACCOUNT_ID;
  if (!raw) throw new Error("Missing META_AD_ACCOUNT_ID environment variable");
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("META_AD_ACCOUNT_ID is empty");
  return ids;
}

export async function fetchMetaAdInsights(since: string, until: string): Promise<MetaAdInsight[]> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error("Missing META_ACCESS_TOKEN environment variable");
  const accountIds = getAdAccountIds();

  const results: MetaAdInsight[] = [];

  for (const accountId of accountIds) {
    const params = new URLSearchParams({
      level: "ad",
      fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend",
      time_range: JSON.stringify({ since, until }),
      time_increment: "1",
      limit: "500",
      access_token: token,
    });

    let url: string | null = `https://graph.facebook.com/${META_API_VERSION}/act_${accountId}/insights?${params.toString()}`;

    while (url) {
      // Explicit annotations break a circular type-inference error TS otherwise
      // raises here: res's inferred type would depend on url's narrowed type,
      // which (via the reassignment below) depends back on res/body.
      const res: Response = await fetch(url);
      const body: any = await res.json();
      if (!res.ok || body.error) {
        throw new Error(`Meta insights request failed for act_${accountId}: ${res.status} ${JSON.stringify(body.error ?? body)}`);
      }
      for (const row of body.data ?? []) {
        results.push({
          accountId,
          campaign_id: row.campaign_id,
          campaign_name: row.campaign_name,
          adset_id: row.adset_id,
          adset_name: row.adset_name,
          ad_id: row.ad_id,
          ad_name: row.ad_name,
          spend: row.spend,
          date_start: row.date_start,
        });
      }
      url = body.paging?.next ?? null;
    }
  }

  return results;
}

// Every place a creative can hide its click-through URL. They're requested as
// one blob and scanned rather than read field by field, because which one is
// populated depends on the creative type (single image, carousel, video,
// Advantage+ catalogue ad), and Meta adds new shapes over time.
const CREATIVE_FIELDS = "creative{object_story_spec,asset_feed_spec,object_url,template_url,link_destination_display_url}";

/** Hosts that serve the ad's own media, never the advertiser's landing page. */
const META_ASSET_HOST = /(^|\.)(fbcdn\.net|fbsbx\.com|facebook\.com|instagram\.com|whatsapp\.com)$/i;

/**
 * The landing pages each ad sends people to. Used to work out which product an
 * ad is selling when its spend needs allocating - the ad/campaign names often
 * don't say. Ads are global objects, so this needs no per-account scoping even
 * though Laurel spans several ad accounts.
 */
export async function fetchAdDestinationUrls(adIds: string[]): Promise<Map<string, string[]>> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error("Missing META_ACCESS_TOKEN environment variable");

  const byAd = new Map<string, string[]>();

  for (let i = 0; i < adIds.length; i += ID_BATCH_SIZE) {
    const batch = adIds.slice(i, i + ID_BATCH_SIZE);
    let creatives: Record<string, any>;
    try {
      creatives = await fetchCreatives(batch, token);
    } catch {
      // One unreadable ad (deleted, or outside the token's scope) fails the
      // whole multi-object read, so retry the batch one at a time and let the
      // others through - a missing suggestion is not worth failing the popup.
      creatives = {};
      for (const adId of batch) {
        try {
          Object.assign(creatives, await fetchCreatives([adId], token));
        } catch {
          continue;
        }
      }
    }

    for (const adId of batch) {
      const urls = landingPageUrls(creatives[adId]?.creative);
      if (urls.length > 0) byAd.set(adId, urls);
    }
  }

  return byAd;
}

async function fetchCreatives(adIds: string[], token: string): Promise<Record<string, any>> {
  const params = new URLSearchParams({ ids: adIds.join(","), fields: CREATIVE_FIELDS, access_token: token });
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/?${params.toString()}`);
  const body: any = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`Meta creative request failed: ${res.status} ${JSON.stringify(body.error ?? body)}`);
  }
  return body;
}

function landingPageUrls(creative: unknown): string[] {
  const urls: string[] = [];
  collectUrls(creative, urls);

  const seen = new Set<string>();
  return urls.filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    try {
      return !META_ASSET_HOST.test(new URL(url).hostname);
    } catch {
      return false;
    }
  });
}

function collectUrls(value: unknown, found: string[]): void {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, found);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, found);
  }
}
