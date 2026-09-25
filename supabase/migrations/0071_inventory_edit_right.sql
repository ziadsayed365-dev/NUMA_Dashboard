-- Purchasing → Inventory gains an edit right.
--
-- The tab was listed in PERMISSION_TREE with no `edit` string, so its checkbox
-- was a dash and canEdit() was permanently false - but the ledger offered the
-- "Transfer to LALA" cells, the adjustment form, the groups editor and the
-- opening balances to anyone who could open it, and /api/inventory's POST only
-- checked view. So view WAS edit. It no longer is: the writes now need
-- "purchasing:inventory" edit, which an owner ticks in Settings → Users.
--
-- Like 0069, this backfill exists so nobody's access changes on deploy day:
-- everyone who can already open the tab could already type into it, and keeps
-- being able to. Untick the box for whoever should only be reading the ledger.
--
-- Run in the Supabase SQL editor. Owners are unaffected - they bypass the map.
-- array[...] rather than a '{...}' literal: the key itself contains a colon,
-- and spelling the path out leaves no doubt about how it parses.
update public.users
set permissions = jsonb_set(
  permissions,
  array['purchasing:inventory'],
  '{"view": true, "edit": true}'::jsonb
)
where role <> 'owner'
  and permissions #>> array['purchasing:inventory', 'view'] = 'true'
  and permissions #>> array['purchasing:inventory', 'edit'] is distinct from 'true';

notify pgrst, 'reload schema';
