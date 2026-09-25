-- Replace the account types with Laurel's canonical accounts (from
-- Accountlaurel.xlsx): ten expense accounts + three income accounts. The Expenses
-- & Income tab records transactions against these. recorded_transactions is
-- empty, so this is a clean reset.
--
-- The ten EXPENSE names deliberately match the Performance P&L's fixed-expense
-- accounts (perf_fixed_expenses / PERF_EXPENSE_ACCOUNTS) exactly, so a closed
-- month's recorded actuals roll up onto the same P&L expense lines. The three
-- INCOME accounts (Bosta, Quick Box, Turbo) are tracked only in the Expenses &
-- Income tab and do not appear in the P&L.
delete from recorded_transactions;
delete from account_types;

insert into account_types (name, type) values
  ('Salaries', 'expense'),
  ('Post Production', 'expense'),
  ('Subscription', 'expense'),
  ('Rent', 'expense'),
  ('Transportation', 'expense'),
  ('Fliers', 'expense'),
  ('Grinding', 'expense'),
  ('Packing fees', 'expense'),
  ('Media Buyer', 'expense'),
  ('Marketing', 'expense'),
  ('Bosta', 'income'),
  ('Quick Box', 'income'),
  ('Turbo', 'income');
