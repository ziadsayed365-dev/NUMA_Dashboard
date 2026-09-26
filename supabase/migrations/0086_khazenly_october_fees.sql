-- Khazenly's new delivery fees from 1 October 2026 (the owner's sheet). The fee
-- sheet becomes date-effective: each row applies to shipments from its
-- effective_from day until a later row for the same governorate takes over, so
-- September's orders keep the 0084/0085 prices and October's get these.
-- src/lib/shipping/fees.ts picks the sheet by the order's Khazenly fulfillment
-- day (bosta_picked_up_day), falling back to its order day.
alter table courier_governorate_fees
  add column if not exists effective_from date not null default '2000-01-01';

alter table courier_governorate_fees drop constraint if exists courier_governorate_fees_pkey;
alter table courier_governorate_fees add primary key (courier, governorate, effective_from);

-- Shopify spellings on the sheet ("Al Sharqia", "Kafr el-Sheikh") are stored under
-- their canonical names (src/lib/governorates.ts).
--
-- New Valley isn't on the sheet: it was priced with the far governorates (0085),
-- so it moves with them to 139.
insert into courier_governorate_fees (courier, governorate, effective_from, delivery_fee) values
  ('khazenly', 'Cairo', '2026-10-01', 78),
  ('khazenly', 'Giza', '2026-10-01', 78),
  ('khazenly', '6th of October', '2026-10-01', 78),
  ('khazenly', 'Alexandria', '2026-10-01', 90),
  ('khazenly', 'Helwan', '2026-10-01', 90),
  ('khazenly', 'Ismailia', '2026-10-01', 101),
  ('khazenly', 'Suez', '2026-10-01', 101),
  ('khazenly', 'Port Said', '2026-10-01', 101),
  ('khazenly', 'Dakahlia', '2026-10-01', 109),
  ('khazenly', 'Qalyubia', '2026-10-01', 109),
  ('khazenly', 'Sharqia', '2026-10-01', 109),
  ('khazenly', 'Gharbia', '2026-10-01', 109),
  ('khazenly', 'Damietta', '2026-10-01', 109),
  ('khazenly', 'Monufia', '2026-10-01', 109),
  ('khazenly', 'Kafr El Sheikh', '2026-10-01', 109),
  ('khazenly', 'Beheira', '2026-10-01', 109),
  ('khazenly', 'Asyut', '2026-10-01', 128),
  ('khazenly', 'Faiyum', '2026-10-01', 128),
  ('khazenly', 'Sohag', '2026-10-01', 128),
  ('khazenly', 'Beni Suef', '2026-10-01', 128),
  ('khazenly', 'Minya', '2026-10-01', 128),
  ('khazenly', 'Red Sea', '2026-10-01', 139),
  ('khazenly', 'South Sinai', '2026-10-01', 139),
  ('khazenly', 'Qena', '2026-10-01', 139),
  ('khazenly', 'Matrouh', '2026-10-01', 139),
  ('khazenly', 'North Sinai', '2026-10-01', 139),
  ('khazenly', 'Aswan', '2026-10-01', 139),
  ('khazenly', 'Luxor', '2026-10-01', 139),
  ('khazenly', 'New Valley', '2026-10-01', 139)
on conflict (courier, governorate, effective_from) do update set delivery_fee = excluded.delivery_fee, updated_at = now();

-- Verification - 29 rows per sheet; old 92 to 154, new 78 to 139:
--   select effective_from, count(*), min(delivery_fee), max(delivery_fee)
--   from courier_governorate_fees where courier = 'khazenly' group by effective_from;
