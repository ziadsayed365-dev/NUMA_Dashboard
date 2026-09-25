-- General "Other" catch-all accounts for the Expenses & Income tab, also shown
-- in the P&L: Other-Expense (reduces net) and Other-Income (adds to net). Their
-- names match PERF_EXPENSE_ACCOUNTS so recorded actuals roll onto the P&L lines.
-- Idempotent: only inserts if the name isn't already present.
insert into account_types (name, type)
select v.name, v.type
from (values ('Other-Expense', 'expense'), ('Other-Income', 'income')) as v(name, type)
where not exists (select 1 from account_types a where a.name = v.name);
