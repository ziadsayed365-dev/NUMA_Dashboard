-- Stock adjustments: the difference between what the ledger calculates and what
-- is physically on the shelf.
--
-- Purchases in, orders out and returns back cover every movement the system
-- knows about, but not the ones only a human sees - spillage, breakage, samples
-- given away, a miscount, stock used for a photo shoot. Without somewhere to put
-- those, the ledger drifts above reality and the only fix is rewriting the
-- opening balance, which falsifies history.
--
-- Two kinds, so the owner never has to do mental arithmetic:
--   'delta' - a movement of +/- qty on that day ("broke 2 bottles" = -2).
--   'count' - a physical recount: qty is what was ACTUALLY on the shelf, and the
--             ledger books whatever delta reconciles it. The balance from that
--             day forward is the counted truth.
create table if not exists inventory_adjustments (
  id bigint generated always as identity primary key,
  date date not null,
  component_id bigint not null references product_components(id) on delete cascade,
  kind text not null default 'delta' check (kind in ('delta', 'count')),
  -- In the component's PRICED unit (KG / L / Pcs), like every Inventory figure.
  -- Signed for 'delta' (negative = stock lost); always >= 0 for 'count'.
  quantity numeric(14, 3) not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists inventory_adjustments_component_date_idx on inventory_adjustments (component_id, date);

alter table inventory_adjustments enable row level security;

notify pgrst, 'reload schema';
