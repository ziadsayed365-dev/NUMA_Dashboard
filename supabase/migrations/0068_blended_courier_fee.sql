-- Actual and Performance no longer agree on what a line item's courier cost is.
-- Actual prices each order with the sheet of the courier that really shipped it;
-- Performance prices every order at a blended rate weighted by the last 7 days
-- of recorded shipments, so a day's shipping economics don't swing on which
-- courier its orders happen to have been recorded to.
--
-- The existing allocated_* columns keep holding the Actual (real-courier)
-- figures. This one column holds the whole blended courier cost for the
-- Performance view - delivery/return fee plus the blended open-package and COD
-- cash fees - because those two are Bosta-only and so are themselves weighted
-- down by Bosta's share of the mix. One combined column rather than three
-- parallel ones: nothing reports the blended pieces separately.
--
-- Nullable with no backfill: computeMargins() rewrites every line item, so the
-- column fills on the next margin run.
alter table order_line_items add column if not exists allocated_courier_fee_blended numeric(12,2);

comment on column order_line_items.allocated_courier_fee_blended is
  'Performance-view courier cost: outcome-resolved fee + open-package + COD cash, blended across couriers by the trailing-7-day shipment mix. Actual uses allocated_courier_fee + allocated_open_package_fee + allocated_cod_cash_fee instead.';
