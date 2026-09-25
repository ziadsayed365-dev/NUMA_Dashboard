-- account_types carried both the template's "Other Expense" / "Other Income"
-- (0018) and the hyphenated "Other-Expense" / "Other-Income" (0045). Keep the
-- hyphenated pair: "Other-Expense" is the name the Income Statement matches
-- recorded amounts on (PERF_EXPENSE_ACCOUNTS). Only removed while unused.
delete from account_types a
where a.name in ('Other Expense', 'Other Income')
  and not exists (select 1 from recorded_transactions t where t.account_type_id = a.id);

notify pgrst, 'reload schema';
