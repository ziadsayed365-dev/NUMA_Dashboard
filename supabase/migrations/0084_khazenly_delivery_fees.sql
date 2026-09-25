-- Khazenly's delivery fee per governorate (the owner's sheet). Khazenly quotes
-- Shopify's own province names, and prices Helwan and 6th of October separately
-- from Cairo and Giza, so those two become governorates of their own here
-- (src/lib/governorates.ts no longer folds them into Cairo / Giza).
--
-- New Valley isn't on the sheet: an order there is priced at the sheet's median
-- fee (see src/lib/shipping/fees.ts) until Khazenly quotes it.
insert into governorate_fees (governorate)
values ('Helwan'), ('6th of October')
on conflict (governorate) do nothing;

insert into courier_governorate_fees (courier, governorate, delivery_fee) values
  ('khazenly', 'Cairo', 92),
  ('khazenly', 'Giza', 92),
  ('khazenly', '6th of October', 92),
  ('khazenly', 'Helwan', 107),
  ('khazenly', 'Alexandria', 107),
  ('khazenly', 'Ismailia', 114),
  ('khazenly', 'Suez', 114),
  ('khazenly', 'Port Said', 114),
  ('khazenly', 'Dakahlia', 123),
  ('khazenly', 'Qalyubia', 123),
  ('khazenly', 'Sharqia', 123),
  ('khazenly', 'Gharbia', 123),
  ('khazenly', 'Damietta', 123),
  ('khazenly', 'Monufia', 123),
  ('khazenly', 'Kafr El Sheikh', 123),
  ('khazenly', 'Beheira', 123),
  ('khazenly', 'Asyut', 143),
  ('khazenly', 'Faiyum', 143),
  ('khazenly', 'Sohag', 143),
  ('khazenly', 'Beni Suef', 143),
  ('khazenly', 'Minya', 143),
  ('khazenly', 'Red Sea', 154),
  ('khazenly', 'South Sinai', 154),
  ('khazenly', 'Qena', 154),
  ('khazenly', 'Matrouh', 154),
  ('khazenly', 'North Sinai', 154),
  ('khazenly', 'Aswan', 154),
  ('khazenly', 'Luxor', 154)
on conflict (courier, governorate) do update set delivery_fee = excluded.delivery_fee, updated_at = now();

-- Verification - 28 rows, 92 to 154:
--   select count(*), min(delivery_fee), max(delivery_fee) from courier_governorate_fees where courier = 'khazenly';
