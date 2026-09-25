-- Give every costed component a baseline purchase (2000-01-01, quantity null)
-- if it doesn't have one. 0046 seeded baselines only for the components that
-- existed when it ran; any component added later had no entry in its price
-- history, so the margin engine (which prices from purchases only) costed every
-- order using it at 0. The app now writes the baseline whenever a component's
-- cost is saved (src/lib/products/components.ts); this backfills the rest.
-- Idempotent: a component that already has a baseline is left alone.
insert into purchases (date, component_id, quantity, amount)
select date '2000-01-01', c.id, null, c.cost
from product_components c
where c.cost is not null
  and not exists (
    select 1 from purchases p
    where p.component_id = c.id and p.quantity is null and p.date = date '2000-01-01'
  );

notify pgrst, 'reload schema';
