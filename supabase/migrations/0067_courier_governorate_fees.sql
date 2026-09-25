-- Quick Connect now has a real per-governorate price sheet, so the delivery fee
-- stops being a Bosta-only number. governorate_fees.delivery_fee held exactly
-- one courier's rates; this table adds the courier dimension so every courier
-- with a known sheet is priced from its own.
--
-- Bosta's rows are copied out of governorate_fees rather than retyped, so the
-- numbers cannot drift from a transcription slip. Its old column is left in
-- place (commented as superseded) instead of dropped: nothing reads it after
-- this migration, and keeping it means applying the migration ahead of the
-- deploy can't break the live Income Statement.
--
-- Turbo is deliberately absent. It still has no price sheet, so it keeps the
-- break-even placeholder in margin.ts; a missing row here is what selects that.
create table if not exists courier_governorate_fees (
  courier text not null,
  governorate text not null references governorate_fees(governorate),
  delivery_fee numeric(12,2) not null,
  updated_at timestamptz not null default now(),
  primary key (courier, governorate)
);

alter table courier_governorate_fees enable row level security;

comment on column governorate_fees.delivery_fee is
  'Superseded by courier_governorate_fees (0067). Bosta-only; no longer read by the app.';

insert into courier_governorate_fees (courier, governorate, delivery_fee)
select 'bosta', governorate, delivery_fee
from governorate_fees
where delivery_fee is not null
on conflict (courier, governorate) do update set delivery_fee = excluded.delivery_fee, updated_at = now();

-- Quick Connect's sheet, VAT-inclusive like Bosta's. The owner's sheet lists 29
-- lines, but "6th of October" (60, same as Giza) and "Helwan" (75) are not
-- governorates - normalizeGovernorate folds them into Giza and Cairo. October
-- agrees with Giza so it folds cleanly; Helwan's 75 conflicts with Cairo's 60
-- and the owner chose Cairo's 60 for the whole governorate, so 75 is dropped
-- rather than represented here.
insert into courier_governorate_fees (courier, governorate, delivery_fee) values
  ('quick_box', 'Cairo', 60),
  ('quick_box', 'Giza', 60),
  ('quick_box', 'Alexandria', 65),
  ('quick_box', 'Beheira', 65),
  ('quick_box', 'Dakahlia', 75),
  ('quick_box', 'Qalyubia', 75),
  ('quick_box', 'Sharqia', 75),
  ('quick_box', 'Gharbia', 75),
  ('quick_box', 'Ismailia', 75),
  ('quick_box', 'Damietta', 75),
  ('quick_box', 'Suez', 75),
  ('quick_box', 'Port Said', 75),
  ('quick_box', 'Monufia', 75),
  ('quick_box', 'Kafr El Sheikh', 75),
  ('quick_box', 'Asyut', 75),
  ('quick_box', 'Faiyum', 75),
  ('quick_box', 'Sohag', 75),
  ('quick_box', 'Beni Suef', 75),
  ('quick_box', 'Minya', 75),
  ('quick_box', 'Red Sea', 95),
  ('quick_box', 'Qena', 95),
  ('quick_box', 'Matrouh', 95),
  ('quick_box', 'Aswan', 95),
  ('quick_box', 'Luxor', 95),
  ('quick_box', 'New Valley', 95),
  ('quick_box', 'South Sinai', 95),
  ('quick_box', 'North Sinai', 95)
on conflict (courier, governorate) do update set delivery_fee = excluded.delivery_fee, updated_at = now();

-- Verification - both couriers should return 27 rows:
--   select courier, count(*), min(delivery_fee), max(delivery_fee)
--   from courier_governorate_fees group by courier;
