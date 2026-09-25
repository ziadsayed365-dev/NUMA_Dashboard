-- Laurel links ad spend by CAMPAIGN (not ad/adset) and allocates each campaign
-- to a PRODUCT (Laurel has no model groups, so the inherited ad->model_group
-- path is dead). Meta spend is also synced across MULTIPLE ad accounts, and a
-- `source` column is reserved so TikTok (and other channels) can slot in later
-- without another migration. The ad_spend table is empty, so this restructures
-- it in place with no data migration.

-- ad_spend: drop the ad/adset-level columns + their unique key, add
-- campaign-level identity, the owning ad account, and the marketing source.
alter table ad_spend drop constraint if exists ad_spend_date_adset_id_ad_id_key;
alter table ad_spend drop column if exists ad_id;
alter table ad_spend drop column if exists adset_id;
alter table ad_spend drop column if exists adset_name;
alter table ad_spend drop column if exists model_group_id;

alter table ad_spend add column if not exists campaign_id text;
alter table ad_spend add column if not exists campaign_name text;
alter table ad_spend add column if not exists account_id text;
alter table ad_spend add column if not exists source text not null default 'meta';

-- One spend row per campaign per day per source.
alter table ad_spend add constraint ad_spend_date_source_campaign_key unique (date, source, campaign_id);

-- Campaign -> product allocation the owner picks in the Analysis-by-Product
-- popup. Persisted so it survives beyond today's rows: the Meta sync re-applies
-- it to any newly-synced (still-unallocated) spend for the same campaign, since
-- a campaign keeps promoting the same product for its whole run.
create table if not exists ad_campaign_assignments (
  campaign_id text primary key,
  product_id bigint not null references products(id) on delete cascade,
  updated_at timestamptz not null default now()
);

-- Legacy IZAR ad->model_group mapping: unused in Laurel (no model groups).
drop table if exists ad_model_assignments;
