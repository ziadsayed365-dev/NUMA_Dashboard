-- "Khazenly Storage Fees": what Khazenly charges to warehouse NUMA's stock. An
-- expense account in Expense & Income, and a fixed-expense line on the P&L
-- (PERF_EXPENSE_ACCOUNTS, slug khazenly_storage_fees). The names must match
-- exactly - that string match is how recorded amounts reach the P&L line.
insert into account_types (name, type)
select 'Khazenly Storage Fees', 'expense'
where not exists (select 1 from account_types where name = 'Khazenly Storage Fees');

notify pgrst, 'reload schema';
