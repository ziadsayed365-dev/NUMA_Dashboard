-- Per-product ad attribution. Migration 0010 dropped product_id from ad_spend
-- (replaced it with model_group_id, itself dropped in 0037), but Laurel
-- allocates ad spend to PRODUCTS, not model groups: Meta ads via the
-- Analysis-by-Product allocation popup, TikTok via manual daily entry. Both
-- write ad_spend.product_id, and the per-product report reads it. Re-add it.
-- NULL = unallocated / "General" (counts in the store-wide P&L marketing total
-- but not attributed to any single product).
alter table ad_spend add column if not exists product_id bigint references products(id) on delete set null;
