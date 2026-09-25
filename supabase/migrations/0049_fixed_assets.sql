-- Fixed assets (Settings -> Fixed Assets). Each asset is depreciated straight
-- line: amount / (useful_life_years * 12) per month, from its purchase month for
-- that many months, then it stops (fully written off, no salvage value). The
-- total across all active assets is shown as a Depreciation line in both the
-- Performance and Actual income statements (daily and monthly).
create table if not exists fixed_assets (
  id bigint generated always as identity primary key,
  name text not null,
  purchase_date date not null,
  amount numeric(12, 2) not null,
  useful_life_years numeric(6, 2) not null check (useful_life_years > 0),
  created_at timestamptz not null default now()
);
