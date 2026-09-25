-- Laurel calibrates delivery rates per PRODUCT (each Shopify product — single
-- or bundle — is its own rate), not per model group (it has none). Re-key the
-- success-rate table from model_group_id to product_id. Table is empty, so no
-- data migration is needed.
delete from product_success_rates;
alter table product_success_rates drop constraint product_success_rates_pkey;
alter table product_success_rates drop column model_group_id;
alter table product_success_rates add column product_id bigint not null references products(id) on delete cascade;
alter table product_success_rates add constraint product_success_rates_pkey primary key (product_id, as_of_date);
