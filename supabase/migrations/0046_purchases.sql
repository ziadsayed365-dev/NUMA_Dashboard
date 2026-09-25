-- Purchases of raw materials / components (the Purchasing tab). Each row records
-- a date, the component bought, the quantity, and the amount = new cost PER UNIT
-- (per the component's priced unit: KG / L / Pcs). A purchase sets that
-- component's cost effective from its date forward (until a later purchase
-- supersedes it), so historical margins use the cost that was in effect at each
-- order's date.
--
-- A seeded baseline row per component (quantity null, effective 2000-01-01)
-- carries the component's current cost, so orders before any real purchase still
-- resolve a cost. The baseline is excluded from the Purchasing list (it has a
-- null quantity).
create table if not exists purchases (
  id bigint generated always as identity primary key,
  date date not null,
  component_id bigint not null references product_components(id) on delete cascade,
  quantity numeric(12, 3),
  amount numeric(12, 2) not null,
  created_at timestamptz not null default now()
);

create index if not exists purchases_component_date_idx on purchases (component_id, date);

insert into purchases (date, component_id, quantity, amount)
select date '2000-01-01', id, null, cost
from product_components
where cost is not null;
