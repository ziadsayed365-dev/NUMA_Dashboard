-- Per-VARIANT bundle contents.
--
-- bundle_items (0035) records what a bundle contains at PRODUCT level: "Bridal
-- Glow Set = 1 Original Moroccan Soap + 1 Natural Body Butter + ... + 1 box".
-- But four of the bundles are sold in variants whose title names the choice
-- inside the box:
--
--   Bridal Glow Set              "moroccan beldi soap / rose body butter / barbie pink"
--   Original Moroccan Hammam Set "moroccan beldi soap / strawberry body butter"
--   Strawberry Skin Treatment Set
--   Hair Growth Set              "The complete package" / "Package without henna"
--
-- Two different things vary. Usually it is WHICH VARIANT of a member goes in
-- (beldi vs nila soap - which have genuinely different raw materials), and
-- sometimes it is WHETHER a member is in the box at all (henna). Both are
-- expressed here: one row per thing inside one bundle VARIANT, optionally
-- naming the member's own variant, with its own quantity (0 = not included).
--
-- Fallback rule, so nothing breaks and nothing has to be filled in at once: a
-- bundle variant with NO rows here falls back to the product-level bundle_items,
-- which is exactly today's behaviour. Rows here REPLACE that list for that one
-- variant.
create table if not exists variant_bundle_items (
  id bigint generated always as identity primary key,
  -- The BUNDLE's own variant (product_variants row of the bundle product).
  bundle_variant_id bigint not null references product_variants(id) on delete cascade,
  -- Exactly one of member_product_id / component_id, mirroring bundle_items.
  member_product_id bigint references products(id) on delete cascade,
  -- Which variant of that member is in the box. Null = unspecified, so the
  -- member costs/deducts at its product base (or its variant average).
  member_variant_id bigint references product_variants(id) on delete set null,
  component_id bigint references product_components(id) on delete cascade,
  quantity numeric(12, 3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((member_product_id is not null)::int + (component_id is not null)::int = 1),
  check (member_variant_id is null or member_product_id is not null),
  unique (bundle_variant_id, member_product_id),
  unique (bundle_variant_id, component_id)
);
create index if not exists variant_bundle_items_variant_idx on variant_bundle_items (bundle_variant_id);
create index if not exists variant_bundle_items_member_idx on variant_bundle_items (member_product_id);

alter table variant_bundle_items enable row level security;

notify pgrst, 'reload schema';
