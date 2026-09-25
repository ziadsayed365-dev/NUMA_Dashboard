-- Purchasing → Inventory: a day-by-day stock ledger per product component, in
-- the component's PRICED unit (KG / L / Pcs) only.
--
--   ending = beginning + purchases + courier returns - orders shipped
--
-- Only two things need storing; every other number is derived from data the app
-- already holds (purchases, orders, chat orders, the BOM):
--
--   inventory_settings.start_date  - the one day the ledger opens on. Shared by
--     every component so the table has a single timeline, and so "was this
--     order shipped before we started counting?" has one answer.
--   inventory_opening_balances     - the physically counted on-hand quantity of
--     each component on that start date, typed once by the owner.
--
-- Deductions are dated by the day an order was handed to a courier (the same
-- actualShipDay rule the Income Statement and the Purchasing Report use), plus
-- Chat Orders on their sale date. Returns are added back on the day the return
-- resolved, but ONLY for orders that shipped on/after start_date - a return of
-- an order that shipped earlier was never deducted here, so crediting it would
-- invent stock.
create table if not exists inventory_settings (
  id int primary key default 1 check (id = 1),
  start_date date not null,
  updated_at timestamptz not null default now()
);

-- Quantity is in the component's priced unit (product_components.unit): KG, L
-- or Pcs. A component with no row here opens at zero.
create table if not exists inventory_opening_balances (
  component_id bigint primary key references product_components(id) on delete cascade,
  quantity numeric(14, 3) not null default 0,
  updated_at timestamptz not null default now()
);

-- Closed to anon/authenticated like every other table (see 0056); the app
-- reaches these through the service-role key, which bypasses RLS.
alter table inventory_settings enable row level security;
alter table inventory_opening_balances enable row level security;

notify pgrst, 'reload schema';
