-- Treat a Shopify "cancelled" TAG as a cancellation.
--
-- The store does not cancel orders in Shopify - it tags them. Only 1 of the
-- 5,623 August orders had a real `cancelledAt`, while 13 carried a Canceled /
-- canceled tag, so the dashboard counted tagged-cancelled orders as live ones.
-- The sync never even fetched `tags`.
--
-- Rather than change the ~14 report/engine modules that each test
-- `cancelled_at is null`, the column is rebuilt as a DERIVED one so every one of
-- those call sites keeps working and silently gains the tag rule:
--   shopify_cancelled_at  - the raw Shopify field, written by the sync
--   tags                  - the raw Shopify tags, written by the sync
--   cancelled_at          - GENERATED: the Shopify timestamp if the order was
--                           really cancelled, else the order's own creation
--                           time when a cancel tag is present, else null
--
-- Only src/lib/sync/shopify-orders.ts writes these; nothing else writes
-- cancelled_at, so making it generated (and therefore read-only) is safe.
alter table orders rename column cancelled_at to shopify_cancelled_at;

alter table orders add column if not exists tags text[] not null default '{}';

-- Substring match, not equality: the store writes both "Canceled" and
-- "canceled", and this also catches "Cancelled" and phrases like "Cancelled by
-- customer". IMMUTABLE is required for a generated column - the body only uses
-- immutable primitives (unnest / lower / like), so the assertion holds. Changing
-- this body later does NOT re-evaluate stored rows; the column must be rebuilt.
create or replace function has_cancel_tag(tags text[]) returns boolean
language sql immutable strict parallel safe as $$
  select coalesce(bool_or(lower(t) like '%cancel%'), false) from unnest(tags) as t
$$;

alter table orders add column cancelled_at timestamptz
  generated always as (
    case
      when shopify_cancelled_at is not null then shopify_cancelled_at
      when has_cancel_tag(tags) then order_created_at
    end
  ) stored;
