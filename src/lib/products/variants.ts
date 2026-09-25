import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";

// A Shopify product variant as shown in the Product List tab. unit_cost stays
// null until the per-variant BOM lands (see 0053_product_variants.sql); price is
// live from Shopify, so the per-variant price spread is already useful on its own.
export type ProductVariant = {
  id: number;
  productId: number;
  sku: string | null;
  title: string | null;
  currentPrice: number | null;
  unitCost: number | null;
};

// Flat list of every variant, product-position then title ordered so a product's
// sizes read naturally. The client groups them by productId. Single-variant
// products (title "Default Title") are included but the UI only expands a
// product when it has more than one.
export async function getProductVariants(): Promise<ProductVariant[]> {
  const rows = await fetchAllRows<{
    id: number;
    product_id: number;
    sku: string | null;
    title: string | null;
    current_price: number | null;
    unit_cost: number | null;
    position: number | null;
  }>(supabase, "product_variants", "id, product_id, sku, title, current_price, unit_cost, position");

  return rows
    .map((r) => ({
      id: r.id,
      productId: r.product_id,
      sku: r.sku,
      title: r.title,
      currentPrice: r.current_price === null ? null : Number(r.current_price),
      unitCost: r.unit_cost === null ? null : Number(r.unit_cost),
      position: r.position ?? 0,
    }))
    .sort((a, b) => a.position - b.position || (a.title ?? "").localeCompare(b.title ?? ""))
    .map(({ position: _position, ...v }) => v);
}
