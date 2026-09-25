-- Add an "Owners Salary" expense account for the Expenses & Income tab. Its name
-- deliberately does NOT match any PERF_EXPENSE_ACCOUNTS label, so recorded
-- amounts against it are tracked in the tab (and the Report sub-tab) but are
-- ignored by the Income Statement P&L - see getRecordedExpensesByMonth /
-- NAME_TO_KEY in src/lib/settings/fixed-expenses.ts.
-- Idempotent: only inserts if the name isn't already present.
insert into account_types (name, type)
select v.name, v.type
from (values ('Owners Salary', 'expense')) as v(name, type)
where not exists (select 1 from account_types a where a.name = v.name);
