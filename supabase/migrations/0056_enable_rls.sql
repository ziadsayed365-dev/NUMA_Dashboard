-- Close the "Table publicly accessible" advisor (rls_disabled_in_public).
-- Every table this project has ever created lives in the public schema, which
-- Supabase exposes over HTTPS through PostgREST. With row-level security off,
-- the anon/publishable key - a key that is designed to be handed to browsers -
-- can read, edit and delete every row. Nothing in this app ships that key
-- (src/lib/supabase.ts is server-only and authenticates with the service-role
-- SUPABASE_SECRET_KEY, and no NEXT_PUBLIC_* Supabase var exists), so the hole
-- is theoretical today, but the key is live on the project and leaks trivially.
--
-- Enabling RLS with NO policies denies anon and authenticated everything, which
-- is exactly right here: this app has no browser-side database access to
-- preserve. The service-role key carries BYPASSRLS, so every server query keeps
-- working untouched - the Shopify, Bosta, Turbo and Meta syncs included. No
-- policy needs to be written for the app to function. If a table ever does need
-- direct client reads, add a policy for it then; until a policy exists the
-- table is simply closed.
--
-- Written as a loop rather than ~36 hand-listed statements so tables created
-- outside these migrations (or added later and re-run) are covered too, and so
-- this never drifts out of sync with the schema.
do $$
declare
  t record;
begin
  for t in
    select tablename
    from pg_tables
    where schemaname = 'public'
    order by tablename
  loop
    execute format('alter table public.%I enable row level security', t.tablename);
    raise notice 'RLS enabled on public.%', t.tablename;
  end loop;
end
$$;

-- Verification - every row should read rowsecurity = true:
--   select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;
