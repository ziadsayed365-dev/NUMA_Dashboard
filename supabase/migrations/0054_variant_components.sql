-- Per-variant bill of materials. Where variants of a product differ only by one
-- ingredient (e.g. Pure Essential Oil's 7 scents share the same bottle + sticker
-- but swap the essential oil), the shared components stay on the product via
-- final_product_components and only the differing component is mapped here.
--
-- A variant's built cost = the product's shared base (final_product_components)
-- + the variant's own lines here. Component costs still come from the Purchasing
-- timeline, so recording a purchase for a scent's oil flows into that variant's
-- cost automatically. One row per (variant, component); mirrors
-- final_product_components (0034).
create table if not exists variant_components (
  id bigint generated always as identity primary key,
  variant_id bigint not null references product_variants(id) on delete cascade,
  component_id bigint not null references product_components(id) on delete cascade,
  quantity numeric(12, 3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (variant_id, component_id)
);
create index if not exists variant_components_variant_idx on variant_components (variant_id);
create index if not exists variant_components_component_idx on variant_components (component_id);
