-- Effective-dated Performance fixed expenses.
--
-- Previously each account was a single flat scalar on settings
-- (perf_*_monthly), applied to EVERY Performance Income Statement month, past
-- and future — so editing an amount retroactively changed all history. This
-- table gives each account a timeline instead: an amount that takes effect from
-- a given month and holds until a later effective row supersedes it. The P&L
-- resolves, per month, the newest amount whose effective_month <= that month.
-- Editing now only affects months on or after the chosen effective month.
--
-- account: stable slug (salaries, post_production, subscription, rent,
--          transportation, fliers, other) — see PERF_EXPENSE_ACCOUNTS.
-- effective_month: always the first day of the month the amount takes effect.
create table if not exists perf_fixed_expenses (
  id bigint generated always as identity primary key,
  account text not null,
  effective_month date not null,
  amount numeric(12,2) not null default 0,
  updated_at timestamptz not null default now(),
  unique (account, effective_month)
);

create index if not exists perf_fixed_expenses_account_idx
  on perf_fixed_expenses (account, effective_month);

-- Seed each account from its existing flat settings scalar, effective from an
-- early baseline so all existing history keeps exactly its current numbers
-- until the owner sets a later effective amount.
insert into perf_fixed_expenses (account, effective_month, amount)
select 'salaries',       date '2000-01-01', perf_salaries_monthly       from settings where id = 1
union all
select 'post_production', date '2000-01-01', perf_post_production_monthly from settings where id = 1
union all
select 'subscription',   date '2000-01-01', perf_subscription_monthly   from settings where id = 1
union all
select 'rent',           date '2000-01-01', perf_rent_monthly           from settings where id = 1
union all
select 'transportation', date '2000-01-01', perf_transportation_monthly from settings where id = 1
union all
select 'fliers',         date '2000-01-01', perf_fliers_monthly         from settings where id = 1
union all
select 'other',          date '2000-01-01', perf_other_monthly          from settings where id = 1
on conflict (account, effective_month) do nothing;
