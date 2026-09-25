-- Transfers to LALA: stock that leaves the warehouse for the sister business.
--
-- It is not a sale, not wastage and not a courier shipment, so none of the
-- existing movements can carry it: purchases come from the Purchasing tab,
-- orders/returns from the couriers, and adjustments are meant for what nobody
-- planned (breakage, samples, recounts). A transfer is a deliberate, recurring
-- outflow the owner types in day by day, so it gets its own deduction line in
-- the rollforward.
--
-- One row per item per day - re-typing a day's figure REPLACES it, the way an
-- editable cell should behave, and a zero clears the row entirely.
create table if not exists inventory_transfers (
  id bigint generated always as identity primary key,
  date date not null,
  component_id bigint references product_components(id) on delete cascade,
  group_id bigint references inventory_groups(id) on delete cascade,
  -- In the item's PRICED unit (KG / L / Pcs), like every Inventory figure.
  -- Positive = stock left for LALA; the ledger subtracts it.
  quantity numeric(14, 3) not null check (quantity >= 0),
  updated_at timestamptz not null default now(),
  check ((component_id is not null)::int + (group_id is not null)::int = 1)
);

create unique index if not exists inventory_transfers_component_day_uidx
  on inventory_transfers (component_id, date) where component_id is not null;
create unique index if not exists inventory_transfers_group_day_uidx
  on inventory_transfers (group_id, date) where group_id is not null;

alter table inventory_transfers enable row level security;

notify pgrst, 'reload schema';
