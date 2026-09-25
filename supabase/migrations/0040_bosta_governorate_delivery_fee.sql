-- Laurel's real Bosta rates are a flat delivery fee per governorate (from the
-- merchant's own Bosta pricing sheet), not the zone x size grid modeled before.
-- Add delivery_fee to governorate_fees and populate all 27 canonical
-- governorates; margin.ts now uses this directly (delivered = this fee;
-- returned/RTO = this fee minus a flat 5.7 EGP). Fees are VAT-inclusive.
-- "6th of October" and "Helwan" are not separate rows - the governorate
-- normalizer folds them into Giza and Cairo respectively.
alter table governorate_fees add column if not exists delivery_fee numeric(12,2);

update governorate_fees set delivery_fee = case governorate
  when 'Cairo' then 66.12
  when 'Giza' then 66.12
  when 'Alexandria' then 70.68
  when 'Beheira' then 70.68
  when 'Dakahlia' then 78.66
  when 'Qalyubia' then 78.66
  when 'Sharqia' then 78.66
  when 'Gharbia' then 78.66
  when 'Ismailia' then 78.66
  when 'Damietta' then 78.66
  when 'Suez' then 78.66
  when 'Port Said' then 78.66
  when 'Monufia' then 78.66
  when 'Kafr El Sheikh' then 78.66
  when 'Asyut' then 93.48
  when 'Faiyum' then 93.48
  when 'Sohag' then 93.48
  when 'Beni Suef' then 93.48
  when 'Minya' then 93.48
  when 'Red Sea' then 106.02
  when 'Qena' then 106.02
  when 'Matrouh' then 106.02
  when 'Aswan' then 106.02
  when 'Luxor' then 106.02
  when 'New Valley' then 106.02
  when 'South Sinai' then 131.10
  when 'North Sinai' then 131.10
  else delivery_fee
end;
