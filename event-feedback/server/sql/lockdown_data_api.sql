-- ============================================================================
-- Lock down the Supabase Data API (PostgREST) for the event-feedback tables
-- ============================================================================
-- WHY:
--   The app connects to Postgres ONLY through a direct node-postgres (pg)
--   connection (DATABASE_URL, the pooler string). It never uses supabase-js,
--   the anon key, or the auto-generated REST/GraphQL API. The Supabase Data
--   API (PostgREST) is therefore pure exposure: anyone with the project URL
--   can read clients / feedback_reports / feedback_requests.
--
-- WHAT THIS DOES (defense in depth, independent of the dashboard toggle):
--   1. Enables ROW LEVEL SECURITY on the three public tables.
--      RLS defaults to deny; the only policies created are explicit
--      "using (false)" denials for the Data API roles (anon, authenticated),
--      so PostgREST sees zero rows.
--   2. Revokes table privileges from anon / authenticated / service_role.
--      (service_role bypasses RLS, so revoking its grants is the only way to
--      stop it; the app never uses service_role against the database.)
--   3. Revokes future default privileges from the postgres role so new tables
--      are not silently exposed either (same statements Supabase
--      recommends; see changelog "Tables not exposed to Data and GraphQL
--      API automatically").
--
-- WHY THE APP IS UNAFFECTED:
--   The app connects as the table owner (role "postgres" via the pooler),
--   and RLS never applies to a table owner unless FORCE ROW LEVEL SECURITY
--   is set (it is not set here). Direct pg queries keep working.
--
--   If the app instead connects as a NON-OWNER custom role, the bottom
--   commented section must be uncommented (replace :APP_ROLE) so that role
--   keeps full access.
--
-- ALSO RECOMMENDED (the primary fix; the dashboard toggle):
--   Supabase Dashboard -> Integrations -> Data API -> toggle "Enable Data API"
--   OFF. The app does not need it, and with the Data API disabled no
--   /rest/v1/* endpoint responds at all, regardless of grants or RLS.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- Safe to run repeatedly (all statements are idempotent).
-- ============================================================================

begin;

-- 1) Enable RLS on all three public tables (no-op when already enabled).
alter table public.clients           enable row level security;
alter table public.feedback_reports  enable row level security;
alter table public.feedback_requests enable row level security;

-- 2) Explicit default-deny policies for the Data API roles.
do $$
declare t text;
begin
  foreach t in array array['clients', 'feedback_reports', 'feedback_requests'] loop
    execute format('drop policy if exists "api_default_deny" on public.%I', t);
    execute format(
      'create policy "api_default_deny" on public.%I
       as restrictive for all
       to anon, authenticated
       using (false) with check (false)', t);
  end loop;
end $$;

-- 3) Revoke privileges from all PostgREST roles (incl. service_role, which
--    bypasses RLS — grant revocation is the only thing that stops it).
revoke all on table public.clients, public.feedback_reports, public.feedback_requests
  from anon, authenticated, service_role;

-- 4) Stop exposing future tables/schemas created by the postgres role too.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;

commit;

-- 5) Diagnostics — report these back when verifying:
select
  t.table_name,
  pg_get_userbyid(t.tableowner) as table_owner,
  t.rowsecurity                  as rls_enabled
from pg_tables t
where t.schemaname = 'public'
  and t.table_name in ('clients', 'feedback_reports', 'feedback_requests')
order by t.table_name;

select current_user as app_connection_role;

-- ============================================================================
-- ONLY IF the app connects with a non-owner role (custom role name in the
-- DATABASE_URL), run this instead / additionally so the app keeps working:
--
--   create policy "allow_app_role_all" on public.clients
--     for all to :APP_ROLE using (true) with check (true);
--   create policy "allow_app_role_all" on public.feedback_reports
--     for all to :APP_ROLE using (true) with check (true);
--   create policy "allow_app_role_all" on public.feedback_requests
--     for all to :APP_ROLE using (true) with check (true);
-- ============================================================================