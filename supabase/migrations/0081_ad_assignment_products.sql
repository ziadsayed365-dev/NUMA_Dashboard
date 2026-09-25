-- An ad can now be pinned to SEVERAL chosen products (the checkbox picker in Ad
-- Allocation), not just one product or General. Three shapes per ad:
--   product_id set,  product_ids null  -> that one product (spend stamped on
--                                          ad_spend.product_id, as before)
--   product_id null, product_ids null  -> General: split each day equally across
--                                          the products sold that day
--   product_id null, product_ids [a,b] -> the chosen products: split equally
--                                          across them (ad_spend.product_id stays
--                                          null; the report splits at read time)
-- A single ticked product is stored the first way, so every existing path that
-- reads ad_spend.product_id keeps working unchanged.
alter table ad_assignments add column if not exists product_ids bigint[];

comment on column ad_assignments.product_ids is
  'Two or more products an ad is split equally across. Null for a single-product (product_id) or General (both null) ad.';

notify pgrst, 'reload schema';
