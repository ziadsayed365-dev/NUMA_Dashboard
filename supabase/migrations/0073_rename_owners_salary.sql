-- Rename the "Owners Salary" account to "Top Management Salary".
--
-- An UPDATE, not a delete + insert: the account keeps its id, so the
-- recorded_transactions already booked against it follow the rename. The name
-- has to move in lockstep with the PERF_EXPENSE_ACCOUNTS label, since
-- getRecordedExpensesByMonth matches recorded amounts onto P&L lines by name
-- (NAME_TO_KEY in src/lib/settings/fixed-expenses.ts).
--
-- The perf_fixed_expenses slug stays "owners_salary" - it is an internal key,
-- never shown, and changing it would orphan the account's amount history.
update account_types
set name = 'Top Management Salary'
where name = 'Owners Salary';
