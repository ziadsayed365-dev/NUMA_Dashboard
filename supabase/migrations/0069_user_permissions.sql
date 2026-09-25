-- Per-user tab permissions, and the end of the `operations` role.
--
-- Replaces the hardcoded per-role page lists (ROLE_ALLOWED_PATHS) with an
-- explicit per-user map of which header tabs and inner tabs a user may see and
-- edit. Owner accounts ignore this column entirely - they always have full
-- access, and only an owner can create or change another owner.
--
-- Shape: { "<page>": {"view":bool,"edit":bool}, "<page>:<tab>": {"view":bool,"edit":bool} }
-- Keys come from PERMISSION_TREE in src/lib/permissions.ts; unknown keys are
-- dropped when the app reads the column.
--
-- Run in the Supabase SQL editor. Until it runs, saving a user fails with
-- "Could not find the 'permissions' column of 'users' in the schema cache".
-- (This project's tables live in `public` - unlike Laundor, nothing here is
-- schema-qualified. Keep it that way or the column lands in the wrong schema.)
alter table public.users add column if not exists permissions jsonb not null default '{}'::jsonb;

-- Staff kept ROLE_ALLOWED_PATHS.staff = ["/", "/products", "/record-data",
-- "/shipping-orders"] - every tab on those four pages, read-only, except the
-- recording tabs any signed-in user could already write to. Movers Orders,
-- Purchasing, Product List and Settings were owner-only and stay off.
update public.users
set permissions = '{
  "income-statement": {"view": true, "edit": false},
  "income-statement:performance": {"view": true, "edit": false},
  "income-statement:actual": {"view": true, "edit": false},
  "products": {"view": true, "edit": false},
  "products:all": {"view": true, "edit": false},
  "products:rollforward": {"view": true, "edit": false},
  "record-data": {"view": true, "edit": false},
  "record-data:expenses": {"view": true, "edit": true},
  "record-data:report": {"view": true, "edit": false},
  "shipping-orders": {"view": true, "edit": false},
  "shipping-orders:orders": {"view": true, "edit": true},
  "shipping-orders:returns": {"view": true, "edit": true},
  "shipping-orders:chat": {"view": true, "edit": true},
  "shipping-orders:analysis": {"view": true, "edit": false}
}'::jsonb
where role = 'staff' and permissions = '{}'::jsonb;

-- `operations` held ROLE_ALLOWED_PATHS.operations = ["/record-data",
-- "/purchasing"]. Those accounts become plain staff carrying exactly that, so
-- nobody's access changes on deploy day. Do this BEFORE the role is rewritten,
-- since the WHERE clause is what identifies them.
update public.users
set permissions = '{
  "record-data": {"view": true, "edit": false},
  "record-data:expenses": {"view": true, "edit": true},
  "record-data:report": {"view": true, "edit": false},
  "purchasing": {"view": true, "edit": false},
  "purchasing:recording": {"view": true, "edit": true},
  "purchasing:report": {"view": true, "edit": false},
  "purchasing:inventory": {"view": true, "edit": false}
}'::jsonb
where role = 'operations';

-- The app's Role type is now owner | staff only; a leftover 'operations' row
-- would fail to log in cleanly, so fold it into staff.
update public.users set role = 'staff' where role = 'operations';

-- PostgREST caches the schema; this makes the new column visible immediately
-- instead of on the next automatic reload.
notify pgrst, 'reload schema';
