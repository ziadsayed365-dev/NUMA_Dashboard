-- Product Components master list: the raw materials, packaging, stickers and
-- other inputs a final product/bundle is built from. The Final Product tab
-- (next step) maps each Shopify product/bundle to one or more of these rows
-- with a quantity, so a product's cost = sum(component.cost * quantity).
--
-- "account" is the human name of the component; the Final Product mapping
-- references components by id (dropdown) but shows this name.
create table if not exists product_components (
  id bigint generated always as identity primary key,
  type text not null check (type in ('raw_material', 'product_package', 'sticker', 'other')),
  account text not null,
  unit text not null check (unit in ('pcs', 'l', 'kg')),
  cost numeric(12, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_components_type_idx on product_components (type);
