-- Muster owner-only Stats drill-down. APPLIED in the Supabase dashboard (SQL Editor) on Oct 16, 2026 with James's OK.
-- Safe to re-run (idempotent) if it ever needs re-applying (after supabase/page_views.sql).
--
-- What it changes:
--  1. page_views gets a nullable user_id column, filled ONLY by the server default auth.uid():
--     signed-in visitors (the app now sends their session token with the page-view insert) get their account id,
--     guests stay NULL. Browsers still cannot write user_id themselves (it is not in the column INSERT grant), and
--     nobody can read page_views through the API. Deleting an account blanks its rows (on delete set null).
--  2. muster_stats_drill(kind, from, to, tz): security definer, refuses anyone for whom muster_is_owner() is false,
--     returns at most 500 rows of who-is-behind-the-number:
--       'visitors' / 'views'  -> per (day-)visitor id: linked account e-mail (or null = anonymous), first/last seen,
--                                view count, pages, devices (in the date range)
--       'accounts' / 'lists'  -> per account: e-mail, signed up, last seen (latest of last sign-in, list save,
--                                page view), saved list count, list names + factions (not deleted)
--     Reads auth.users (email, created_at, last_sign_in_at), public.page_views and public.lists. Writes nothing.
--  3. execute only for signed-in users (the owner check inside does the rest); revoked from anon/public.
-- The service_role key is never used by the app.

-- 1. link page views to the signed-in account (server-side only)
alter table public.page_views add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete set null;
create index if not exists page_views_user_idx on public.page_views (user_id) where user_id is not null;
-- (column grants are unchanged: anon/authenticated may only insert kind, view, device, ref_host, visitor)

-- 2. owner-only drill-down
create or replace function public.muster_stats_drill(p_kind text, p_from date, p_to date, p_tz text default 'UTC') returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  tz text := coalesce(nullif(p_tz, ''), 'UTC');
  a timestamptz; b timestamptz;
begin
  if not public.muster_is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind not in ('visitors', 'views', 'accounts', 'lists') then raise exception 'bad kind' using errcode = '22023'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'bad range' using errcode = '22023'; end if;
  if not exists (select 1 from pg_timezone_names where name = tz) then tz := 'UTC'; end if;
  a := p_from::timestamp at time zone tz;
  b := (p_to + 1)::timestamp at time zone tz;

  if p_kind in ('visitors', 'views') then
    return (
      select jsonb_build_object('kind', p_kind, 'rows', coalesce(jsonb_agg(r order by r->>'last' desc), '[]'::jsonb))
      from (
        select jsonb_build_object(
                 'visitor', v.visitor,
                 'email', (select u.email from auth.users u where u.id = (array_agg(v.user_id) filter (where v.user_id is not null))[1]),
                 'first', min(v.ts), 'last', max(v.ts), 'views', count(*),
                 'pages', (select jsonb_agg(distinct x) from unnest(array_agg(v.view)) x),
                 'devices', (select jsonb_agg(distinct x) from unnest(array_agg(v.device)) x)) as r
        from public.page_views v
        where v.ts >= a and v.ts < b
        group by v.visitor
        order by max(v.ts) desc
        limit 500
      ) q
    );
  end if;

  return (
    select jsonb_build_object('kind', p_kind, 'rows', coalesce(jsonb_agg(r order by (r->>'list_count')::int desc, r->>'email'), '[]'::jsonb))
    from (
      select jsonb_build_object(
               'email', u.email,
               'signed_up', u.created_at,
               'last_seen', greatest(u.last_sign_in_at,
                                     (select max(l.updated_at) from public.lists l where l.user_id = u.id),
                                     (select max(p.ts) from public.page_views p where p.user_id = u.id)),
               'list_count', (select count(*) from public.lists l where l.user_id = u.id and not l.deleted),
               'lists', (select coalesce(jsonb_agg(jsonb_build_object('name', l.data->>'name', 'faction', l.data->>'faction') order by l.updated_at desc), '[]'::jsonb)
                         from public.lists l where l.user_id = u.id and not l.deleted)) as r
      from auth.users u
      order by u.created_at desc
      limit 500
    ) q
  );
end;
$$;

revoke all on function public.muster_stats_drill(text, date, date, text) from public, anon;
grant execute on function public.muster_stats_drill(text, date, date, text) to authenticated;

notify pgrst, 'reload schema';
