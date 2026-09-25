-- New Valley wasn't on Khazenly's sheet (0084); the owner prices it at 154, the
-- same as the other far governorates.
insert into courier_governorate_fees (courier, governorate, delivery_fee)
values ('khazenly', 'New Valley', 154)
on conflict (courier, governorate) do update set delivery_fee = excluded.delivery_fee, updated_at = now();
