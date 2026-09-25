-- Laurel allocates ad spend at the AD level (finest granularity): each
-- individual ad is allocated to a product, not the whole campaign or ad set.
-- One campaign / ad set can hold ads promoting different products, so ad-level
-- is the most accurate attribution. The full Meta hierarchy (campaign -> ad set
-- -> ad) is stored for display/grouping in the allocation popup, but the
-- allocation KEY and the spend uniqueness key are the ad.
--
-- ad_spend currently holds campaign-level rows; the grain is changing, so this
-- clears it and resets the Meta cursor for a clean re-sync at ad level.

-- Add the ad-set + ad identity columns (campaign_id/campaign_name already exist).
alter table ad_spend add column if not exists adset_id text;
alter table ad_spend add column if not exists adset_name text;
alter table ad_spend add column if not exists ad_id text;
alter table ad_spend add column if not exists ad_name text;

-- One spend row per ad per day per source (was: per campaign per day).
alter table ad_spend drop constraint if exists ad_spend_date_source_campaign_key;
alter table ad_spend add constraint ad_spend_date_source_ad_key unique (date, source, ad_id);

-- Clear the campaign-grain rows and reset the cursor so the Meta sync re-pulls
-- everything at ad level.
truncate table ad_spend;
update sync_state set cursor = null, last_synced_at = null where source = 'meta';

-- Ad -> product allocation the owner picks in the Analysis-by-Product popup.
-- Replaces the campaign-keyed table. Persisted so it survives beyond today's
-- rows: the Meta sync re-applies it to any newly-synced (still-unallocated)
-- spend for the same ad.
create table if not exists ad_assignments (
  ad_id text primary key,
  product_id bigint not null references products(id) on delete cascade,
  updated_at timestamptz not null default now()
);

-- Campaign-keyed allocation table: superseded by ad-level allocation.
drop table if exists ad_campaign_assignments;
