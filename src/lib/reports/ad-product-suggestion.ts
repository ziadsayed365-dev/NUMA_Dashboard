import "server-only";
import { unstable_cache } from "next/cache";
import { fetchAdDestinationUrls } from "@/lib/meta";
import { supabase } from "@/lib/supabase";

// An ad's creative (and so its landing page) doesn't change once it's live -
// editing the link makes a new ad - so this can be cached hard. It only exists
// to save repeat Graph calls while the allocation popup is open.
const SUGGESTION_CACHE_SECONDS = 86_400;

// Guard against a huge fan-out to Meta if the popup ever opens with a large
// unallocated backlog; the rest simply come back without a suggestion.
const MAX_ADS_PER_REQUEST = 100;

// Shopify product URLs are /products/<handle>, optionally behind a collection
// or locale prefix (/collections/sale/products/x, /en/products/x).
const PRODUCT_PATH = /\/products\/([^/?#]+)/i;

// A fuzzy match needs to share most of the shorter name's words. Below this,
// "Runner Black" and "Runner Trainer White" start looking like the same thing.
const FUZZY_MIN_SCORE = 0.6;

export type AdProductSuggestion = {
  adId: string;
  /** The landing page the ad clicks through to, for the owner to verify against. */
  url: string | null;
  /** Product handle taken from that URL, shown when nothing in the catalog matched. */
  handle: string | null;
  productId: number | null;
  /** Named exactly as the dropdown lists it, so the two can be read together. */
  productLabel: string | null;
  /** Set when the handle named a model rather than one product under it. */
  modelName: string | null;
  /** True when the handle matched a catalog name outright, rather than by word overlap. */
  exact: boolean;
};

type Entry = { slug: string; words: Set<string>; id: number; label: string };

export async function getAdProductSuggestions(adIds: string[]): Promise<AdProductSuggestion[]> {
  const ids = [...new Set(adIds)].slice(0, MAX_ADS_PER_REQUEST).sort();
  if (ids.length === 0) return [];

  const [urlsByAd, catalog] = await Promise.all([getCachedDestinationUrls(ids), loadCatalog()]);

  return ids.map((adId) => {
    const urls = urlsByAd[adId] ?? [];
    const productUrl = urls.find((url) => PRODUCT_PATH.test(url)) ?? null;
    const handle = productUrl ? decodeURIComponent(PRODUCT_PATH.exec(productUrl)![1]) : null;

    const base: AdProductSuggestion = {
      adId,
      url: productUrl ?? urls[0] ?? null,
      handle,
      productId: null,
      productLabel: null,
      modelName: null,
      exact: false,
    };
    if (!handle) return base;

    const handleSlug = slugify(handle);
    const handleWords = words(handle);

    const exactProduct = catalog.products.find((entry) => entry.slug === handleSlug);
    if (exactProduct) {
      return { ...base, productId: exactProduct.id, productLabel: exactProduct.label, exact: true };
    }

    // The handle can name the model rather than one colourway of it. That only
    // resolves to something allocatable when the model holds a single product;
    // otherwise the model name is reported as a hint and the choice is left open,
    // since picking one colourway arbitrarily would be a guess at the owner's
    // expense.
    const exactModel = catalog.models.find((entry) => entry.slug === handleSlug);
    if (exactModel) {
      const under = catalog.productsByModel.get(exactModel.id) ?? [];
      if (under.length === 1) {
        return { ...base, productId: under[0].id, productLabel: under[0].label, modelName: exactModel.label, exact: true };
      }
      return { ...base, modelName: exactModel.label, exact: true };
    }

    const nearProduct = bestMatch(handleWords, catalog.products);
    if (nearProduct) {
      return { ...base, productId: nearProduct.entry.id, productLabel: nearProduct.entry.label };
    }

    const nearModel = bestMatch(handleWords, catalog.models);
    if (nearModel) {
      const under = catalog.productsByModel.get(nearModel.entry.id) ?? [];
      if (under.length === 1) {
        return { ...base, productId: under[0].id, productLabel: under[0].label, modelName: nearModel.entry.label };
      }
      return { ...base, modelName: nearModel.entry.label };
    }

    return base;
  });
}

// Keyed by the sorted ad-id list: the popup asks for the same set on every
// render, and the set only changes once an ad has been allocated (which takes
// it off the list for good).
const getCachedDestinationUrls = unstable_cache(
  async (adIds: string[]): Promise<Record<string, string[]>> => Object.fromEntries(await fetchAdDestinationUrls(adIds)),
  ["ad-destination-urls"],
  { revalidate: SUGGESTION_CACHE_SECONDS }
);

// Labels are built exactly as getProductOptions builds them, so a suggestion
// reads identically to the entry it pre-selects in the dropdown.
async function loadCatalog(): Promise<{ products: Entry[]; models: Entry[]; productsByModel: Map<number, Entry[]> }> {
  const { data: productRows, error } = await supabase.from("products").select("id, name, model_group_id");
  if (error) throw new Error(`Failed to load products: ${error.message}`);
  const { data: modelRows, error: mErr } = await supabase.from("model_groups").select("id, name");
  if (mErr) throw new Error(`Failed to load model_groups: ${mErr.message}`);

  const modelName = new Map((modelRows ?? []).map((m) => [m.id as number, m.name as string]));

  const products: Entry[] = [];
  const productsByModel = new Map<number, Entry[]>();
  for (const p of productRows ?? []) {
    const model = p.model_group_id ? modelName.get(p.model_group_id) ?? "?" : null;
    const label = model && model.trim() !== p.name.trim() ? `${model} — ${p.name}` : p.name;
    // Matched on the product's own name, not the composed label - the label
    // repeats the model name, which would skew the word overlap.
    const entry: Entry = { slug: slugify(p.name), words: words(p.name), id: p.id, label };
    products.push(entry);
    if (p.model_group_id) {
      const list = productsByModel.get(p.model_group_id) ?? [];
      list.push(entry);
      productsByModel.set(p.model_group_id, list);
    }
  }

  const models: Entry[] = (modelRows ?? []).map((m) => ({
    slug: slugify(m.name),
    words: words(m.name),
    id: m.id,
    label: m.name,
  }));

  return { products, models, productsByModel };
}

function bestMatch(handleWords: Set<string>, entries: Entry[]): { entry: Entry; score: number } | null {
  let best: { entry: Entry; score: number } | null = null;
  for (const entry of entries) {
    const score = overlap(handleWords, entry.words);
    if (score >= FUZZY_MIN_SCORE && (!best || score > best.score)) best = { entry, score };
  }
  return best;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  // Scored against the shorter name, so "laurel-runner" still matches the
  // product "Laurel Runner Black 42" - the extra colour/size words don't count
  // against it. A single shared word is too weak to act on.
  if (shared < 2 && Math.min(a.size, b.size) > 1) return 0;
  return shared / Math.min(a.size, b.size);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function words(value: string): Set<string> {
  return new Set(slugify(value).split("-").filter(Boolean));
}
