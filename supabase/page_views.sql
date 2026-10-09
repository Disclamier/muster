-- Muster owner-only traffic stats (replaces the GoatCounter idea). NOT applied yet: run once in the Supabase dashboard
-- -> SQL Editor -> New query -> Run, AFTER replacing the e-mail placeholder in step 4 with the owner's Muster sign-in e-mail.
-- Safe to re-run (idempotent).
--
-- What gets stored: one row per app load / main view change with only
--   ts (server time), kind (load|view), view (signin|lists|editor|meta|share|other), device (phone|tablet|pc),
--   ref_host (referring site's host name only, e.g. "reddit.com"; never a path or query), and
--   visitor (16 random hex chars made on the device, replaced every day; not derived from anything about the person).
-- Never stored: IP address, user id, e-mail, list content, cookies, user agent, country.
-- The browser only ever INSERTs; reading is only possible through muster_stats(), which answers aggregates to the owner.

-- 1. table ---------------------------------------------------------------------------------------------------------
create table if not exists public.page_views (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  kind      text not null default 'view' check (kind in ('load', 'view')),
  view      text not null check (view in ('signin', 'lists', 'editor', 'meta', 'share', 'other')),
  device    text not null check (device in ('phone', 'tablet', 'pc')),
  ref_host  text check (ref_host is null or (char_length(ref_host) between 1 and 100 and ref_host ~ '^[a-z0-9.-]+$')),
  visitor   text not null check (visitor ~ '^[0-9a-f]{16}$')
);
create index if not exists page_views_ts_idx on public.page_views (ts);

-- 2. access: anyone with the public anon key may INSERT the five allowed columns (ts/id are server-set);
--    nobody may SELECT / UPDATE / DELETE through the API
alter table public.page_views enable row level security;
revoke all on public.page_views from anon, authenticated;
grant insert (kind, view, device, ref_host, visitor) on public.page_views to anon, authenticated;
drop policy if exists "page_views_insert_any" on public.page_views;
create policy "page_views_insert_any" on public.page_views for insert to anon, authenticated with check (true);

-- 3. owner list (by Supabase auth user id; holds no e-mail). Not readable through the API.
create table if not exists public.muster_owners (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  added_at  timestamptz not null default now()
);
alter table public.muster_owners enable row level security;
revoke all on public.muster_owners from anon, authenticated;

-- 4. make the owner's Muster account the owner (replace the placeholder with the e-mail used to sign in to Muster)
insert into public.muster_owners (user_id)
  select id from auth.users where lower(email) = lower('OWNER-MUSTER-EMAIL@example.com') and email_confirmed_at is not null
  on conflict do nothing;

-- 5. functions (security definer = run with table-owner rights, but each checks the caller first)
create or replace function public.muster_is_owner() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.muster_owners o where o.user_id = auth.uid());
$$;

-- aggregates for p_from..p_to (inclusive, calendar days in p_tz). Raw rows never leave the database.
-- "visitors" = distinct daily visitor ids (ids rotate daily, so over several days this counts visitor-days).
create or replace function public.muster_stats(p_from date, p_to date, p_tz text default 'UTC') returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  tz text := coalesce(nullif(p_tz, ''), 'UTC');
  a timestamptz; b timestamptz;
begin
  if not public.muster_is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'bad range' using errcode = '22023'; end if;
  if not exists (select 1 from pg_timezone_names where name = tz) then tz := 'UTC'; end if;
  a := p_from::timestamp at time zone tz;
  b := (p_to + 1)::timestamp at time zone tz;
  return (
    with v as (
      select (ts at time zone tz)::date as d, kind, view, device, ref_host, visitor
      from public.page_views where ts >= a and ts < b
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'tz', tz,
      'totals', (select jsonb_build_object(
          'visits', count(*) filter (where kind = 'load'),
          'views', count(*),
          'visitors', count(distinct (d, visitor))) from v),
      'daily', (select coalesce(jsonb_agg(jsonb_build_object('d', g.d, 'visits', coalesce(x.visits, 0),
                  'views', coalesce(x.views, 0), 'visitors', coalesce(x.visitors, 0)) order by g.d), '[]'::jsonb)
          from (select generate_series(p_from::timestamp, p_to::timestamp, interval '1 day')::date as d) g
          left join (select d, count(*) filter (where kind = 'load') as visits, count(*) as views,
                            count(distinct visitor) as visitors from v group by d) x on x.d = g.d),
      'by_view', (select coalesce(jsonb_agg(jsonb_build_object('k', view, 'n', n) order by n desc), '[]'::jsonb)
          from (select view, count(*) as n from v group by view) q),
      'by_device', (select coalesce(jsonb_agg(jsonb_build_object('k', device, 'n', n) order by n desc), '[]'::jsonb)
          from (select device, count(distinct (d, visitor)) as n from v group by device) q),
      'referrers', (select coalesce(jsonb_agg(jsonb_build_object('k', ref_host, 'n', n) order by n desc), '[]'::jsonb)
          from (select ref_host, count(*) as n from v where ref_host is not null group by ref_host order by n desc limit 10) q),
      'lists', (select jsonb_build_object(
          'saved', (select count(*) from public.lists where not deleted),
          'accounts', (select count(*) from auth.users)))
    )
  );
end;
$$;

revoke all on function public.muster_is_owner() from public, anon;
revoke all on function public.muster_stats(date, date, text) from public, anon;
grant execute on function public.muster_is_owner() to authenticated;
grant execute on function public.muster_stats(date, date, text) to authenticated;

-- optional housekeeping (run by hand when wanted): drop rows older than ~13 months
-- delete from public.page_views where ts < now() - interval '400 days';

-- let the API see the new table / functions right away
notify pgrst, 'reload schema';
