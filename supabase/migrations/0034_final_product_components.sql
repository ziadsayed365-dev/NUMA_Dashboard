-- Bill of materials: maps each Shopify product (final product) to the
-- components it is built from, each with a quantity. A product's built cost =
-- sum(product_components.cost * quantity) across its rows here.
--
-- The component's TYPE (raw_material / product_package / sticker / other) is
-- read from product_components, so the Final Product tab can group a product's
-- rows into one column per type. One row per (product, component).
create table if not exists final_product_components (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  component_id bigint not null references product_components(id) on delete cascade,
  quantity numeric(12, 3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, component_id)
);
create index if not exists final_product_components_product_idx on final_product_components (product_id);
create index if not exists final_product_components_component_idx on final_product_components (component_id);
