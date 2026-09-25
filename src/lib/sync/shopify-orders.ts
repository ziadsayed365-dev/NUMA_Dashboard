import "server-only";
import { supabase } from "@/lib/supabase";
import { getShopifyAccessToken, shopifyGraphQL } from "@/lib/shopify";
import { withRetry } from "@/lib/retry";

const PAGE_SIZE = 50;
// Leaves headroom under Vercel's 60s function limit, including the worst-case
// retry backoff below (~2.8s).
const TIME_BUDGET_MS = 40_000;

// Shopify exposes several "prices" per line item, and the gap between them is
// every discount the store gave away. Storing originalUnitPrice (the list
// price) booked discounts as revenue that was never collected.
// `discountAllocations` is the reliable net basis: it carries BOTH line-level
// discounts (EACH/ENTITLED) and order-level ones (ACROSS/ALL), which
// `discountedTotalSet` alone can miss.
type MoneyBag = { shopMoney?: { amount?: string | number | null } | null } | null;

type ShopifyLineItem = {
  id: string;
  quantity: number;
  title?: string | null;
  originalUnitPriceSet?: MoneyBag;
  originalTotalSet?: MoneyBag;
  discountAllocations?: Array<{ allocatedAmountSet?: MoneyBag }> | null;
  product?: { id: string } | null;
  variant?: { id: string } | null;
};

function money(bag: MoneyBag | undefined): number {
  return Number(bag?.shopMoney?.amount ?? 0);
}

function netLineTotal(line: ShopifyLineItem): number {
  const original = money(line.originalTotalSet);
  const allocated = (line.discountAllocations ?? []).reduce((sum, a) => sum + money(a?.allocatedAmountSet), 0);
  return Math.max(original - allocated, 0);
}

// Shopify's subtotalPrice is the authority on an order's goods value net of
// every discount (it excludes shipping, tracked separately as
// shipping_fee_charged). Per-line allocations can round a few piastres away
// from it, so nudge the lines to sum to it exactly. Only rounding-scale gaps
// are corrected: subtotalPrice is also reduced by RETURNS, and a refunded order
// legitimately diverges - that is modelled downstream as refund_adjustment.
const SUBTOTAL_RECONCILE_TOLERANCE = 0.02; // 2%

function reconcileToSubtotal(netTotals: number[], subtotal: number | null): number[] {
  if (subtotal === null || !Number.isFinite(subtotal) || subtotal <= 0) return netTotals;
  const sum = netTotals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return netTotals;
  const drift = Math.abs(sum - subtotal);
  if (drift <= 0.01) return netTotals;
  if (drift / subtotal > SUBTOTAL_RECONCILE_TOLERANCE) return netTotals;
  const scale = subtotal / sum;
  return netTotals.map((t) => t * scale);
}

// Only sync orders created on or after this date. The store's pre-2026 history
// is not needed and just bloats the sync, so it's excluded at the source.
const ORDERS_CREATED_SINCE = "2026-01-01";

type SyncResult = {
  ok: boolean;
  ordersProcessed: number;
  reachedEnd: boolean;
  error?: string;
};

// Egypt day = fixed UTC+3 offset, matching the same rule used in the database.
function toEgyptDay(isoDate: string): string {
  const shifted = new Date(new Date(isoDate).getTime() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// Khazenly (NUMA's only courier) writes each parcel's status back onto the
// Shopify fulfillment, so the courier outcome is read straight off the order -
// there is no separate courier API. Seen on the live store: DELIVERED (with
// deliveredAt), NOT_DELIVERED, ATTEMPTED_DELIVERY, OUT_FOR_DELIVERY, FULFILLED.
type ShopifyFulfillment = {
  status?: string | null;
  displayStatus?: string | null;
  createdAt?: string | null;
  deliveredAt?: string | null;
  trackingInfo?: Array<{ number?: string | null }> | null;
};

const FAILED_STATUSES = new Set(["NOT_DELIVERED", "FAILURE", "CANCELED"]);

type Shipment = {
  shippedDay: string | null; // Egypt day of the first fulfillment - the handover to Khazenly
  trackingNumber: string | null;
  outcome: "delivered" | "failed_rto" | "in_transit" | null;
  resolvedAt: string | null;
  attemptNumber: number | null;
};

function classifyShipment(fulfillments: ShopifyFulfillment[]): Shipment {
  // A cancelled / errored fulfillment never left the building.
  const live = fulfillments.filter((f) => f.status !== "CANCELLED" && f.status !== "ERROR");
  if (live.length === 0) return { shippedDay: null, trackingNumber: null, outcome: null, resolvedAt: null, attemptNumber: null };

  const shippedDay =
    live
      .map((f) => f.createdAt)
      .filter((v): v is string => Boolean(v))
      .map(toEgyptDay)
      .sort()[0] ?? null;
  const trackingNumber = live.flatMap((f) => f.trackingInfo ?? []).map((t) => t?.number).find(Boolean) ?? null;
  const attemptNumber = live.some((f) => f.displayStatus === "ATTEMPTED_DELIVERY") ? 2 : 1;

  const delivered = live.find((f) => f.displayStatus === "DELIVERED");
  if (delivered) {
    return { shippedDay, trackingNumber, outcome: "delivered", resolvedAt: delivered.deliveredAt ?? null, attemptNumber };
  }
  if (live.some((f) => FAILED_STATUSES.has(f.displayStatus ?? ""))) {
    // Dated by the shipped day, the same rule a hand-uploaded return follows
    // (src/lib/shipping/orders.ts) - the Inventory ledger credits stock back on it.
    return { shippedDay, trackingNumber, outcome: "failed_rto", resolvedAt: shippedDay, attemptNumber };
  }
  return { shippedDay, trackingNumber, outcome: "in_transit", resolvedAt: null, attemptNumber };
}

const ORDERS_QUERY = `
  query Orders($cursor: String, $searchQuery: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $searchQuery, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          name
          createdAt
          cancelledAt
          tags
          displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          subtotalPriceSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          shippingAddress { province name phone }
          phone
          customer { id displayName phone }
          fulfillments(first: 10) {
            status
            displayStatus
            createdAt
            deliveredAt
            trackingInfo { number }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                quantity
                title
                originalUnitPriceSet { shopMoney { amount } }
                originalTotalSet { shopMoney { amount } }
                discountAllocations { allocatedAmountSet { shopMoney { amount } } }
                product { id }
                variant { id }
              }
            }
          }
        }
      }
    }
  }
`;

export async function syncShopifyOrders(): Promise<SyncResult> {
  const startedAt = Date.now();

  try {
    const accessToken = await getShopifyAccessToken();

    const { data: state, error: stateErr } = await supabase
      .from("sync_state")
      .select("*")
      .eq("source", "shopify")
      .single();
    if (stateErr) throw new Error(`Failed to read sync_state: ${stateErr.message}`);

    let cursor: string | null = null;
    let since: string | null = state?.last_synced_at ?? null;
    if (state?.cursor) {
      try {
        const parsed = JSON.parse(state.cursor);
        cursor = parsed.after ?? null;
        since = parsed.since ?? since;
      } catch {
        // malformed cursor from a previous bug, just restart the pass
      }
    }

    // Always floor at ORDERS_CREATED_SINCE; add the incremental updated_at
    // filter on top once we've completed a first full pass.
    const filters = [`created_at:>=${ORDERS_CREATED_SINCE}`];
    if (since) filters.push(`updated_at:>='${since}'`);
    const searchQuery = filters.join(" AND ");
    const passStartedAt = new Date().toISOString();
    const productCache = new Map<string, number | null>();
    const variantCache = new Map<string, number | null>();

    let ordersProcessed = 0;
    let reachedEnd = false;
    // Cursor of the last page that finished cleanly. Persisted even when the
    // pass ends in an error, so a failure costs one page of re-work rather than
    // replaying from wherever it last succeeded.
    let lastGoodCursor: string | null = cursor;

    try {
      while (true) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) break;

        const data = await withRetry(() => shopifyGraphQL<any>(accessToken, ORDERS_QUERY, { cursor, searchQuery }));
        const edges = data.orders.edges;
        if (edges.length === 0) {
          reachedEnd = true;
          break;
        }

        for (const edge of edges) {
          await withRetry(() => upsertOrder(edge.node, productCache, variantCache));
          ordersProcessed++;
        }

        cursor = edges[edges.length - 1].cursor;
        lastGoodCursor = cursor;
        if (!data.orders.pageInfo.hasNextPage) {
          reachedEnd = true;
          break;
        }
      }
    } catch (err) {
      // Checkpoint the pages that did land before giving up.
      await saveSyncState({ reachedEnd: false, since, cursor: lastGoodCursor, passStartedAt });
      return {
        ok: false,
        ordersProcessed,
        reachedEnd: false,
        error: err instanceof Error ? err.message : "unknown error",
      };
    }

    await saveSyncState({ reachedEnd, since, cursor, passStartedAt });

    return { ok: true, ordersProcessed, reachedEnd };
  } catch (err) {
    return {
      ok: false,
      ordersProcessed: 0,
      reachedEnd: false,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

// A completed pass clears the cursor and advances the incremental watermark; an
// incomplete one only records where to resume, leaving the watermark alone so
// nothing updated mid-pass is skipped next time.
async function saveSyncState(opts: {
  reachedEnd: boolean;
  since: string | null;
  cursor: string | null;
  passStartedAt: string;
}) {
  const update = opts.reachedEnd
    ? { last_synced_at: opts.passStartedAt, cursor: null, updated_at: new Date().toISOString() }
    : { cursor: JSON.stringify({ since: opts.since, after: opts.cursor }), updated_at: new Date().toISOString() };
  await supabase.from("sync_state").update(update).eq("source", "shopify");
}

async function upsertOrder(
  node: any,
  productCache: Map<string, number | null>,
  variantCache: Map<string, number | null>
) {
  const shopifyOrderId = node.id.split("/").pop();
  const orderCreatedAt = node.createdAt;
  const totalPrice = node.totalPriceSet?.shopMoney?.amount ?? null;
  const governorate = node.shippingAddress?.province ?? null;
  const shipment = classifyShipment(node.fulfillments ?? []);

  // A return uploaded by hand is the later, better fact - a parcel Khazenly
  // marked DELIVERED can still come back - so while one is on record the
  // outcome columns are left exactly as the upload set them.
  const { data: existing, error: existingErr } = await supabase
    .from("orders")
    .select("return_recorded_at")
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();
  if (existingErr) throw new Error(`Failed to read order ${node.name}: ${existingErr.message}`);
  const outcomeFields = existing?.return_recorded_at
    ? {}
    : {
        outcome: shipment.outcome,
        outcome_governorate: shipment.outcome ? governorate : null,
        resolved_at: shipment.resolvedAt,
        attempt_number: shipment.attemptNumber,
        // COD is collected on delivery, so a delivered order collected its total.
        cod_amount_collected: shipment.outcome === "delivered" ? totalPrice : null,
      };

  const { data: orderRow, error: orderErr } = await supabase
    .from("orders")
    .upsert(
      {
        shopify_order_id: shopifyOrderId,
        order_number: node.name,
        order_created_at: orderCreatedAt,
        egypt_day: toEgyptDay(orderCreatedAt),
        total_price: totalPrice,
        currency: node.totalPriceSet?.shopMoney?.currencyCode ?? "EGP",
        shipping_fee_charged: node.totalShippingPriceSet?.shopMoney?.amount ?? null,
        governorate_shopify: governorate,
        shopify_cancelled_at: node.cancelledAt ?? null,
        tags: node.tags ?? [],
        financial_status: node.displayFinancialStatus ?? null,
        // Shipped = Shopify shows a Khazenly fulfillment. The column names are
        // inherited from the Bosta era (see migration 0076).
        // Who ordered - the Subscription tab groups renewals by customer.
        customer_shopify_id: node.customer?.id ? String(node.customer.id).split("/").pop() : null,
        customer_name: node.customer?.displayName ?? node.shippingAddress?.name ?? null,
        customer_phone: node.customer?.phone ?? node.shippingAddress?.phone ?? node.phone ?? null,
        courier: shipment.shippedDay ? "khazenly" : null,
        bosta_picked_up_day: shipment.shippedDay,
        bosta_tracking_number: shipment.trackingNumber,
        ...outcomeFields,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shopify_order_id" }
    )
    .select("id")
    .single();

  if (orderErr || !orderRow) {
    throw new Error(`Failed to upsert order ${node.name}: ${orderErr?.message}`);
  }

  // Net-of-discount line totals, nudged to sum to Shopify's own subtotal.
  const lines: ShopifyLineItem[] = (node.lineItems?.edges ?? []).map((e: { node: ShopifyLineItem }) => e.node);
  const netTotals = reconcileToSubtotal(
    lines.map(netLineTotal),
    node.subtotalPriceSet?.shopMoney?.amount != null ? Number(node.subtotalPriceSet.shopMoney.amount) : null
  );

  for (const [lineIndex, line] of lines.entries()) {
    const shopifyLineItemId = line.id.split("/").pop();
    const shopifyProductId: string | null = line.product?.id ? (line.product.id.split("/").pop() ?? null) : null;

    let productId: number | null = null;
    if (shopifyProductId) {
      if (productCache.has(shopifyProductId)) {
        productId = productCache.get(shopifyProductId) ?? null;
      } else {
        const { data: product } = await supabase
          .from("products")
          .select("id")
          .eq("shopify_product_id", shopifyProductId)
          .maybeSingle();
        productId = product?.id ?? null;
        productCache.set(shopifyProductId, productId);
      }
    }

    // Which of the product's variants was actually bought - drives per-variant
    // costing (a 100ml sale costs more than a 10ml one). Resolved the same way
    // as the product; null if the variant hasn't been synced yet, and relinked
    // by the catalog sync via shopify_variant_id once it has.
    const shopifyVariantId: string | null = line.variant?.id ? (line.variant.id.split("/").pop() ?? null) : null;
    let variantId: number | null = null;
    if (shopifyVariantId) {
      if (variantCache.has(shopifyVariantId)) {
        variantId = variantCache.get(shopifyVariantId) ?? null;
      } else {
        const { data: variant } = await supabase
          .from("product_variants")
          .select("id")
          .eq("shopify_variant_id", shopifyVariantId)
          .maybeSingle();
        variantId = variant?.id ?? null;
        variantCache.set(shopifyVariantId, variantId);
      }
    }

    const { error: lineErr } = await supabase.from("order_line_items").upsert(
      {
        order_id: orderRow.id,
        product_id: productId,
        shopify_product_id: shopifyProductId,
        variant_id: variantId,
        shopify_variant_id: shopifyVariantId,
        shopify_line_item_id: shopifyLineItemId,
        quantity: line.quantity,
        // NET (post-discount) price: margin.ts derives revenue as
        // quantity * unit_price, so storing the list price here overstated
        // revenue by every discount ever given.
        unit_price:
          line.quantity > 0 ? netTotals[lineIndex] / line.quantity : money(line.originalUnitPriceSet),
        product_title_raw: productId ? null : line.title,
      },
      { onConflict: "shopify_line_item_id" }
    );
    if (lineErr) {
      throw new Error(`Failed to upsert line item ${shopifyLineItemId}: ${lineErr.message}`);
    }
  }
}
