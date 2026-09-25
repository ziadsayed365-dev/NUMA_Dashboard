-- Narrow the cancel-tag rule from 0074: a cancel tag only counts when the
-- courier did NOT deliver the order.
--
-- Backfilling the tags surfaced 2,193 cancel-tagged orders - but 179 of them
-- were DELIVERED, and 163 of those collected cash (131,251 EGP of
-- cod_amount_collected). The tag on a delivered order is added after the fact (a
-- return request, a complaint, a mislabel); the money was still collected, so
-- treating it as "never placed" would delete real revenue from the P&L.
--
-- Delivery is therefore the stronger signal: a real Shopify cancellation still
-- always wins, a cancel tag wins over nothing and over a failed/RTO outcome, and
-- an actual delivery wins over the tag. `outcome` is filled in later by the
-- courier sync, and because the column is generated it re-evaluates on every
-- update - a tagged order that is still in transit counts as cancelled today and
-- flips back on its own if it goes on to deliver.
alter table orders drop column cancelled_at;

alter table orders add column cancelled_at timestamptz
  generated always as (
    case
      when shopify_cancelled_at is not null then shopify_cancelled_at
      when has_cancel_tag(tags) and outcome is distinct from 'delivered' then order_created_at
    end
  ) stored;
