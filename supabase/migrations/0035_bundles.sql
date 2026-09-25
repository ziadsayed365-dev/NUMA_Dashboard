-- Bundles vs single products. A bundle is a Shopify product that is built from
-- other (single) final products plus optionally some "Other" components (e.g.
-- the box it ships in). is_bundle splits the Final Product tab into two
-- sections; single products keep their raw-material/package/sticker mapping,
-- bundles get their own contents mapping below.
alter table products add column if not exists is_bundle boolean not null default false;

-- Seed the known bundles by name (matches the current Shopify catalog).
update products set is_bundle = true
where name in (
  'Aromatic Hammam',
  'Essential Hammam Ritual',
  'Moroccan Strawberry Glow',
  'Golden Musk Journey',
  'Nila Whitening bundle',
  'Strawberry kit',
  'Bridal Glow Set',
  'Strawberry Skin Treatment Set',
  'Hair Growth Set',
  'Original Moroccan Hammam Set'
);

-- One row per thing inside a bundle. Each row references EXACTLY ONE of:
--   member_product_id -> a single final product (cost = its built cost)
--   component_id      -> an "Other" component such as the box (cost = per-unit)
-- Both are offered in the same dropdown in the UI.
create table if not exists bundle_items (
  id bigint generated always as identity primary key,
  bundle_product_id bigint not null references products(id) on delete cascade,
  member_product_id bigint references products(id) on delete cascade,
  component_id bigint references product_components(id) on delete cascade,
  quantity numeric(12, 3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((member_product_id is not null)::int + (component_id is not null)::int = 1),
  unique (bundle_product_id, member_product_id),
  unique (bundle_product_id, component_id)
);
create index if not exists bundle_items_bundle_idx on bundle_items (bundle_product_id);
