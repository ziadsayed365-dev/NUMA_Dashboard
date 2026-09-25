-- A single chat_orders row can stand for MORE THAN ONE real order. The owner
-- sometimes bundles several chats into one record (e.g. 10 orders typed as one
-- record with one revenue figure). Revenue, COGS and items are already the
-- bundle's totals, so those need no scaling - but the Orders count (Chat Orders
-- feed Orders Placed / Orders Resolved on both Income Statement tabs, see
-- src/lib/reports/daily-pnl.ts) is a per-order tally, so reporting has to know
-- how many real orders a row represents. Defaults to 1 - one row, one order -
-- which is exactly how every existing record and every future single-order
-- record behaves.
alter table chat_orders
  add column if not exists order_count int not null default 1 check (order_count > 0);

notify pgrst, 'reload schema';
