-- Performance-tab fixed expenses. The Performance Income Statement subtracts a
-- set of flat monthly fixed-expense accounts (owner-editable in Settings) plus
-- an "Other" catch-all (kept at the prior 1,560,000 average). These are
-- separate from the Actual tab's per-order computed salaries/rent/transportation
-- - the Performance view intentionally uses simple flat monthly figures.
alter table settings add column if not exists perf_salaries_monthly numeric(12,2) not null default 0;
alter table settings add column if not exists perf_post_production_monthly numeric(12,2) not null default 0;
alter table settings add column if not exists perf_subscription_monthly numeric(12,2) not null default 0;
alter table settings add column if not exists perf_rent_monthly numeric(12,2) not null default 0;
alter table settings add column if not exists perf_transportation_monthly numeric(12,2) not null default 0;
alter table settings add column if not exists perf_fliers_monthly numeric(12,2) not null default 0;
alter table settings add column if not exists perf_other_monthly numeric(12,2) not null default 1560000;
