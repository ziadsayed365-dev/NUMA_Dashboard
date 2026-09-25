-- NUMA ships everything through Khazenly, and Khazenly writes each parcel's
-- status back onto the Shopify fulfillment (DELIVERED / NOT_DELIVERED /
-- OUT_FOR_DELIVERY ..., tracking numbers like KH-NUMA-07860715). So the Shopify
-- order sync is now the only courier feed: there is no Bosta API, and no Turbo /
-- Quick Connect shipments recorded by hand. Returns are still uploaded by hand
-- (Shipping Orders > Record Returns).
--
-- The inherited column names are kept rather than renamed - every report reads
-- them - but they now carry Khazenly's data:
--   bosta_picked_up_day   = the Egypt day of the order's first Shopify fulfillment
--   bosta_tracking_number = Khazenly's tracking number off that fulfillment

alter table orders drop constraint if exists orders_courier_check;
alter table orders add constraint orders_courier_check check (courier = 'khazenly');

comment on column orders.bosta_picked_up_day is
  'Khazenly: Egypt day of the first Shopify fulfillment (the handover). Name inherited from the Bosta era.';
comment on column orders.bosta_tracking_number is
  'Khazenly tracking number from the Shopify fulfillment. Name inherited from the Bosta era.';

-- When a return was uploaded by hand. While set, the Shopify sync never
-- rewrites the order's outcome: a parcel Khazenly marked DELIVERED can still come
-- back afterwards, and the owner's upload is the later, better fact.
alter table orders add column if not exists return_recorded_at timestamptz;

-- No Bosta sync any more.
delete from sync_state where source = 'bosta';

-- Only Khazenly is priced. Its sheet goes in as ('khazenly', governorate, fee)
-- rows; until then the margin engine prices a shipment at the Shopify shipping
-- fee charged (break-even placeholder).
delete from courier_governorate_fees where courier <> 'khazenly';
