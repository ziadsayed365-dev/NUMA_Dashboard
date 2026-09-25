-- Add an "operations" role: an operational user (e.g. amr) who can record
-- Expense & Income and use the Purchasing tab, but sees nothing else (no Income
-- Statement, Analysis, Shipping, Product List, or Settings).
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('owner', 'staff', 'operations'));
