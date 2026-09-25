-- Inventory groups: several components that are counted as ONE line of stock.
--
-- Inventory counts per whole product, but some products keep their real raw
-- material on the variant - each essential oil scent is its own component, so
-- the ledger showed seven near-identical rows, each carrying an even slice of
-- every oil shipped. The owner wants one "Essential oil" line instead.
--
-- This is a STOCK-COUNTING view only. The components stay separate everywhere
-- else, which matters: the scents cost between 2,500 and 3,450 per litre, and
-- merging them for real would flatten that into one wrong number. Costing,
-- purchasing and the BOM are untouched.
create table if not exists inventory_groups (
  id bigint generated always as identity primary key,
  name text not null,
  -- Every member must share this unit; the group's balance is meaningless
  -- otherwise (you cannot add litres to pieces).
  unit text not null check (unit in ('pcs', 'l', 'kg')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table product_components
  add column if not exists inventory_group_id bigint references inventory_groups(id) on delete set null;
create index if not exists product_components_inventory_group_idx on product_components (inventory_group_id);

-- Opening balances and adjustments now hang off an "item" - either a group or a
-- single ungrouped component - because that is what the owner physically counts.
-- Both tables are empty (the ledger has never been opened), so they are simply
-- reshaped rather than migrated.
drop table if exists inventory_opening_balances;
create table inventory_opening_balances (
  id bigint generated always as identity primary key,
  component_id bigint references product_components(id) on delete cascade,
  group_id bigint references inventory_groups(id) on delete cascade,
  quantity numeric(14, 3) not null default 0,
  updated_at timestamptz not null default now(),
  check ((component_id is not null)::int + (group_id is not null)::int = 1),
  unique (component_id),
  unique (group_id)
);

alter table inventory_adjustments
  add column if not exists group_id bigint references inventory_groups(id) on delete cascade;
alter table inventory_adjustments alter column component_id drop not null;
-- Existing rows (none in production) all carry a component, so this holds.
alter table inventory_adjustments drop constraint if exists inventory_adjustments_target_check;
alter table inventory_adjustments add constraint inventory_adjustments_target_check
  check ((component_id is not null)::int + (group_id is not null)::int = 1);
create index if not exists inventory_adjustments_group_date_idx on inventory_adjustments (group_id, date);

alter table inventory_groups enable row level security;
alter table inventory_opening_balances enable row level security;

-- Seed the one the owner asked for: the seven per-scent oils become a single
-- "Essential oil" line. The generic 'الزيت العطري الخام - Essential oil' is
-- deliberately NOT a member - it is a different raw material, used by Sudanese
-- Dilka as well, and folding it in would hide that usage.
insert into inventory_groups (name, unit)
select 'Essential oil', 'l'
where not exists (select 1 from inventory_groups where name = 'Essential oil');

update product_components
   set inventory_group_id = (select id from inventory_groups where name = 'Essential oil'),
       updated_at = now()
 where account like 'Essential oil - %'
   and unit = 'l';

notify pgrst, 'reload schema';
