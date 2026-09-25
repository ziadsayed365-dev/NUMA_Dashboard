-- Couriers are now Bosta / Turbo / Quick Box (Movers was replaced by Turbo and
-- Quick Box). Widen the courier CHECK constraint accordingly. 'movers' is kept
-- in the allowed set only so any legacy rows (there are none in practice) don't
-- break; new recordings use the three current couriers.
alter table orders drop constraint if exists orders_courier_check;
alter table orders add constraint orders_courier_check
  check (courier = any (array['bosta'::text, 'turbo'::text, 'quick_box'::text, 'movers'::text]));
