import "server-only";
import { supabase } from "@/lib/supabase";
import { getShopifyAccessToken, shopifyGraphQL } from "@/lib/shopify";

const PAGE_SIZE = 50;
const TIME_BUDGET_MS = 45_000; // leave headroom under Vercel's 60s function limit

type SyncResult = {
  ok: boolean;
  newProducts: number;
  error?: string;
};

const PRODUCTS_QUERY = `
  query Products($cursor: String) {
    products(first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          title
          status
          variants(first: 100) {
            edges { node { id sku price title position } }
          }
        }
      }
    }
  }
`;

// Full catalog diff every run, rather than an incremental cursor like the
// orders sync - the catalog is small (~100 products), so re-fetching it all
// each time is simpler and more robust than tracking updated_at state.
// Revisit if the catalog grows much larger.
export async function syncShopifyProducts(): Promise<SyncResult> {
  const startedAt = Date.now();

  try {
    const accessToken = await getShopifyAccessToken();

    const { data: existingRows, error: existingErr } = await supabase.from("products").select("id, shopify_product_id");
    if (existingErr) throw new Error(`Failed to load existing products: ${existingErr.message}`);

    const byShopifyId = new Map<string, number>();
    for (const row of existingRows ?? []) {
      if (row.shopify_product_id != null) byShopifyId.set(String(row.shopify_product_id), row.id);
    }

    let cursor: string | null = null;
    let newProducts = 0;

    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      // Explicit annotation breaks a circular type-inference error TS otherwise
      // raises here: data's inferred type would depend on cursor's narrowed
      // type, which (via the reassignment below) depends back on data itself.
      const data: any = await shopifyGraphQL<any>(accessToken, PRODUCTS_QUERY, { cursor });
      const edges = data.products.edges;
      if (edges.length === 0) break;

      for (const edge of edges) {
        const wasNew = await upsertProduct(edge.node, byShopifyId);
        if (wasNew) newProducts++;
      }

      cursor = edges[edges.length - 1].cursor;
      if (!data.products.pageInfo.hasNextPage) break;
    }

    return { ok: true, newProducts };
  } catch (err) {
    return {
      ok: false,
      newProducts: 0,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

async function upsertProduct(node: any, byShopifyId: Map<string, number>): Promise<boolean> {
  const shopifyId: string = node.id.split("/").pop();
  const variantNodes: any[] = node.variants.edges.map((e: any) => e.node);
  // Product-level sku/price still track the first variant, so the many surfaces
  // that read products.sku / current_price keep working unchanged; the full set
  // lives in product_variants (synced below).
  const firstVariant = variantNodes[0];
  const sku: string | null = firstVariant?.sku ?? null;
  const price: number | null = firstVariant?.price != null ? Number(firstVariant.price) : null;
  const now = new Date().toISOString();

  const existingId = byShopifyId.get(shopifyId);
  let wasNew = false;
  let productId: number;
  if (existingId) {
    const { error } = await supabase
      .from("products")
      .update({ sku, current_price: price, status: node.status, price_synced_at: now, updated_at: now })
      .eq("id", existingId);
    if (error) throw new Error(`Failed to update product ${shopifyId}: ${error.message}`);
    productId = existingId;
  } else {
    const { data: inserted, error } = await supabase
      .from("products")
      .insert({ shopify_product_id: shopifyId, name: node.title, sku, current_price: price, status: node.status, price_synced_at: now })
      .select("id")
      .single();
    if (error || !inserted) throw new Error(`Failed to insert product ${shopifyId}: ${error?.message}`);
    byShopifyId.set(shopifyId, inserted.id);
    productId = inserted.id;
    wasNew = true;

    // Backfill any order lines that already arrived for this product before it
    // existed in our table (e.g. ordered before its SKU was set up here) - two
    // separate updates rather than one .or() call, to avoid string-escaping
    // pitfalls with titles containing commas.
    await supabase.from("order_line_items").update({ product_id: inserted.id }).is("product_id", null).eq("shopify_product_id", shopifyId);
    await supabase
      .from("order_line_items")
      .update({ product_id: inserted.id })
      .is("product_id", null)
      .is("shopify_product_id", null)
      .eq("product_title_raw", node.title);
  }

  await upsertVariants(productId, variantNodes, node.status, now);

  return wasNew;
}

// One product_variants row per Shopify variant, keyed by shopify_variant_id.
// unit_cost is never written here - it is owned by the (future) per-variant BOM,
// so a re-sync only refreshes Shopify-sourced fields and never clobbers a cost.
async function upsertVariants(productId: number, variantNodes: any[], status: string, now: string): Promise<void> {
  for (const v of variantNodes) {
    const shopifyVariantId: string | null = v.id ? v.id.split("/").pop() : null;
    if (!shopifyVariantId) continue;
    const row = {
      product_id: productId,
      shopify_variant_id: shopifyVariantId,
      sku: v.sku ?? null,
      title: v.title ?? null,
      current_price: v.price != null ? Number(v.price) : null,
      status,
      position: v.position ?? null,
      price_synced_at: now,
      updated_at: now,
    };
    const { data: variant, error } = await supabase
      .from("product_variants")
      .upsert(row, { onConflict: "shopify_variant_id" })
      .select("id")
      .single();
    if (error || !variant) throw new Error(`Failed to upsert variant ${shopifyVariantId}: ${error?.message}`);

    // Relink any line items that recorded this variant before it existed here,
    // mirroring the product-level backfill above.
    await supabase
      .from("order_line_items")
      .update({ variant_id: variant.id })
      .is("variant_id", null)
      .eq("shopify_variant_id", shopifyVariantId);
  }
}
