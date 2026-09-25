-- Who placed each order, from Shopify. The Subscription tab groups the monthly
-- subscription orders by customer to see who renewed and who didn't, and shows
-- the name + phone so the owner can follow up.
--
-- customer_shopify_id is the grouping key (a customer keeps it across orders).
-- Name and phone are denormalised onto the order as Shopify had them at the
-- time - phone falls back to the shipping address when the customer record has
-- none. Filled by the Shopify order sync; older rows get them on a full re-sync.
alter table orders add column if not exists customer_shopify_id text;
alter table orders add column if not exists customer_name text;
alter table orders add column if not exists customer_phone text;

create index if not exists orders_customer_shopify_id_idx on orders (customer_shopify_id);

notify pgrst, 'reload schema';
