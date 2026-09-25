-- Account list change for the Expenses & Income tab.
--
-- Out: "Fliers" and "Grinding" - dropped from PERF_EXPENSE_ACCOUNTS too, so they
-- no longer appear as Settings → Fixed Expenses editors or as Income Statement
-- lines. Only removed here when nothing has ever been recorded against them
-- (recorded_transactions.account_type_id is a FK); if an account survives this
-- migration, reassign its transactions first and re-run.
--
-- Their perf_fixed_expenses rows are deliberately left in place: the loader
-- ignores slugs it doesn't know, so the old amounts stay recoverable.
delete from account_types a
where a.name in ('Fliers', 'Grinding')
  and not exists (select 1 from recorded_transactions t where t.account_type_id = a.id);

-- In: "Office supplies" and "Refunds" - each name matches its
-- PERF_EXPENSE_ACCOUNTS label exactly, so recorded actuals roll up onto the same
-- P&L fixed-expense line.
-- Idempotent per account: only inserts the names that are not already present.
insert into account_types (name, type)
select v.name, v.type
from (values ('Office supplies', 'expense'), ('Refunds', 'expense')) as v(name, type)
where not exists (select 1 from account_types a where a.name = v.name);
