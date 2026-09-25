-- "Chat Orders": orders taken over chat and fulfilled directly, recorded by hand
-- in the Shipping Orders → Chat Orders tab. Nothing syncs them and no courier is
-- ever involved, so they are always 100% delivered - which is why they carry no
-- outcome/return columns and read as a flat 100% rate in the Analysis tab.
--
-- Replaces three_p_sales (0047), whose flat one-row-per-product shape couldn't
-- express an order. three_p_sales is left in place (it was always empty) rather
-- than dropped.
--
-- Revenue is ONE owner-typed figure for the whole order (the price agreed in the
-- chat), NOT a sum over the line items - which is why it lives on the order and
-- not the items. The items exist only to price COGS.
create table if not exists chat_orders (
  id bigint generated always as identity primary key,
  sale_date date not null,
  revenue numeric(12, 2) not null check (revenue >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chat_orders_date_idx on chat_orders (sale_date);

-- cost_of_goods is snapshotted at write time from the product's built cost as it
-- stood on sale_date (getBuiltCostResolver in src/lib/products/final-products.ts -
-- the same resolver the margin engine costs Shopify orders with). Snapshotting
-- means a later component purchase can't silently rewrite an already-recorded
-- order. Editing an order re-prices every item, since the date or quantities may
-- have moved.
create table if not exists chat_order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references chat_orders(id) on delete cascade,
  product_id bigint not null references products(id),
  quantity int not null check (quantity > 0),
  cost_of_goods numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists chat_order_items_order_idx on chat_order_items (order_id);

notify pgrst, 'reload schema';
