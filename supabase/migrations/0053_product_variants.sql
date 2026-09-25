-- One row per Shopify product VARIANT. A product with a single variant gets one
-- row; multi-variant products (e.g. an essential oil sold in several sizes) get
-- one row per size, each carrying its own Shopify price and, later, its own cost.
--
-- unit_cost is intentionally left NULL for now. It will be populated by a
-- per-variant bill of materials once the raw-material -> finished-product model
-- is extended to the variant level (today's final_product_components is keyed by
-- product, not variant). Until then the margin engine falls back to the
-- product-level built cost, so nothing regresses while this layer is empty.
create table if not exists product_variants (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  shopify_variant_id bigint unique,
  sku text,
  title text,                 -- Shopify variant title, e.g. "10ml" or "Default Title"
  current_price numeric(12,2),
  unit_cost numeric(12,2),    -- null until per-variant BOM lands; see note above
  status text,                -- mirrors the parent product's Shopify status
  position int,               -- Shopify variant order, so sizes list naturally
  price_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_variants_product_idx on product_variants (product_id);

-- Attribute each sold line to the exact variant, so a 100ml sale is costed
-- differently from a 10ml one. Nullable + backfilled the same way product_id is:
-- a line that arrived before its variant existed here gets relinked on the next
-- catalog sync (shopify_variant_id is the durable key for that relink, mirroring
-- shopify_product_id added in 0029).
alter table order_line_items add column if not exists variant_id bigint references product_variants(id);
alter table order_line_items add column if not exists shopify_variant_id bigint;
create index if not exists order_line_items_variant_id_idx on order_line_items (variant_id);
