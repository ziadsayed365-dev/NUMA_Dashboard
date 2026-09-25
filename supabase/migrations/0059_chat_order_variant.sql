-- Chat Orders record a product but never which VARIANT was sold, so a "Musk oil"
-- chat sale costs at the average of the seven scents and - since Inventory
-- deducts what the BOM says - takes 1/7 of each scent off stock instead of a
-- bottle of musk. The owner knows which one they sold; this lets them say so.
--
-- Nullable on purpose: existing rows genuinely don't know, and a single-variant
-- product has nothing to choose. Null keeps today's behaviour (product base, or
-- the variant average where the product is variant-costed).
alter table chat_order_items add column if not exists variant_id bigint references product_variants(id);
create index if not exists chat_order_items_variant_idx on chat_order_items (variant_id);

notify pgrst, 'reload schema';
