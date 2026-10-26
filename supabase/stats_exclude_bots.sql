-- Muster Stats: leave out our own automated visits (headless post-deploy checks run from the build box).
-- NOT applied yet. Run once in the Supabase dashboard -> SQL Editor only after James OKs it. Safe to re-run (idempotent).
--
-- Why a filter and not a delete: page_views stores no user agent and no IP, so past bot rows can only be recognised by
-- WHEN they happened. Nothing is deleted or changed in page_views; the Stats numbers just read a filtered view.
--
-- What it does:
--  1. new table public.muster_stats_bot_windows (from_ts, to_ts, note): time windows when our headless checks visited
--     the live site. Filled with the 30 minutes after each successful deploy since page_views started (the times
--     GitHub Actions finished publishing; our live checks ran right after). No API access (RLS on, all grants revoked).
--  2. new view public.page_views_human = page_views minus "bot visitor-days": an ANONYMOUS visitor id (user_id null)
--     whose every row on that day falls inside one window. A real visitor who also visits outside the window, or who is
--     signed in, is never removed. (Small risk: a real anonymous visitor whose whole visit that day was inside one
--     30-minute window after a deploy is also left out.) No API access.
--  3. re-creates muster_stats() and muster_stats_drill() exactly as before (page_views.sql / stats_drilldown.sql),
--     except that visits / views / visitors / devices / referrers and the visitor drill-down read page_views_human
--     instead of page_views. Lists saved / accounts are unchanged (headless checks run as guests and save nothing).
--  4. Going forward the app itself no longer sends rows for headless browsers (app/js/stats.js), so new windows are
--     only needed if an older app version is ever checked headless again:
--       insert into public.muster_stats_bot_windows (from_ts, to_ts, note) values ('...', '...', 'why');
-- Undo: re-run supabase/page_views.sql step 5 and supabase/stats_drilldown.sql step 2 (functions read page_views again),
-- then drop view public.page_views_human; drop table public.muster_stats_bot_windows;

-- 1. windows
create table if not exists public.muster_stats_bot_windows (
  id       bigint generated always as identity primary key,
  from_ts  timestamptz not null,
  to_ts    timestamptz not null check (to_ts > from_ts),
  note     text,
  unique (from_ts, to_ts)
);
alter table public.muster_stats_bot_windows enable row level security;
revoke all on public.muster_stats_bot_windows from anon, authenticated;
insert into public.muster_stats_bot_windows (from_ts, to_ts, note) values
  ('2026-10-15T23:14:07Z'::timestamptz, '2026-10-15T23:14:07Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Data: Field Manual v1.6'),
  ('2026-10-16T00:04:58Z'::timestamptz, '2026-10-16T00:04:58Z'::timestamptz + interval '30 minutes', 'post-deploy live check: CSM marks test'),
  ('2026-10-16T01:11:10Z'::timestamptz, '2026-10-16T01:11:10Z'::timestamptz + interval '30 minutes', 'post-deploy live check: NR parity pass 2'),
  ('2026-10-16T01:27:03Z'::timestamptz, '2026-10-16T01:27:03Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Export rules appendix'),
  ('2026-10-16T02:09:18Z'::timestamptz, '2026-10-16T02:09:18Z'::timestamptz + interval '30 minutes', 'post-deploy live check: CSM Mark of Chaos'),
  ('2026-10-16T03:32:39Z'::timestamptz, '2026-10-16T03:32:39Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Datasheet view wargear'),
  ('2026-10-16T14:03:22Z'::timestamptz, '2026-10-16T14:03:22Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Refresh Black Templars'),
  ('2026-10-16T23:28:27Z'::timestamptz, '2026-10-16T23:28:27Z'::timestamptz + interval '30 minutes', 'post-deploy live check: stats_drilldown'),
  ('2026-10-16T23:46:16Z'::timestamptz, '2026-10-16T23:46:16Z'::timestamptz + interval '30 minutes', 'post-deploy live check: stats_lists'),
  ('2026-10-17T00:53:16Z'::timestamptz, '2026-10-17T00:53:16Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Custodes MFM verify'),
  ('2026-10-17T02:23:54Z'::timestamptz, '2026-10-17T02:23:54Z'::timestamptz + interval '30 minutes', 'post-deploy live check: NR parity curated'),
  ('2026-10-17T03:28:16Z'::timestamptz, '2026-10-17T03:28:16Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Loadout pickers'),
  ('2026-10-17T04:07:02Z'::timestamptz, '2026-10-17T04:07:02Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Custodes codex audit'),
  ('2026-10-17T22:41:18Z'::timestamptz, '2026-10-17T22:41:18Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Stats delta badge'),
  ('2026-10-17T23:56:38Z'::timestamptz, '2026-10-17T23:56:38Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Stats view missing profiles'),
  ('2026-10-18T00:44:03Z'::timestamptz, '2026-10-18T00:44:03Z'::timestamptz + interval '30 minutes', 'post-deploy live check: Stats wargear/Mark'),
  ('2026-10-19T01:53:15Z'::timestamptz, '2026-10-19T01:53:15Z'::timestamptz + interval '30 minutes', 'post-deploy live check: v58 Custodes army rules'),
  ('2026-10-19T02:14:38Z'::timestamptz, '2026-10-19T02:14:38Z'::timestamptz + interval '30 minutes', 'post-deploy live check: v59 Necrons'),
  ('2026-10-19T03:11:20Z'::timestamptz, '2026-10-19T03:11:20Z'::timestamptz + interval '30 minutes', 'post-deploy live check: CSM DP marks'),
  ('2026-10-19T04:47:31Z'::timestamptz, '2026-10-19T04:47:31Z'::timestamptz + interval '30 minutes', 'post-deploy live check: v62 Army rules row'),
  ('2026-10-19T05:58:03Z'::timestamptz, '2026-10-19T05:58:03Z'::timestamptz + interval '30 minutes', 'post-deploy live check: v63 text import'),
  ('2026-10-22T05:15:23Z'::timestamptz, '2026-10-22T05:15:23Z'::timestamptz + interval '30 minutes', 'post-deploy live check: v64 list names'),
  ('2026-10-22T11:07:52Z'::timestamptz, '2026-10-22T11:07:52Z'::timestamptz + interval '30 minutes', 'post-deploy live check: v66 attached stats'),
  ('2026-10-25T21:20:24Z'::timestamptz, '2026-10-25T21:20:24Z'::timestamptz + interval '30 minutes', 'post-deploy live check: v67 Reaper''s Wager / Contagion Engines / Plasmacyte')
on conflict (from_ts, to_ts) do nothing;

-- 2. filtered view (owner rights; used only inside the security-definer stats functions)
create or replace view public.page_views_human as
  select p.* from public.page_views p
  where not exists (
    select 1 from public.muster_stats_bot_windows w
    where p.user_id is null and p.ts >= w.from_ts and p.ts < w.to_ts
      and not exists (                                   -- the same visitor id has no row outside this window
        select 1 from public.page_views q
        where q.visitor = p.visitor and (q.ts < w.from_ts or q.ts >= w.to_ts or q.user_id is not null)
          and q.ts > w.from_ts - interval '2 days' and q.ts < w.to_ts + interval '2 days'));
revoke all on public.page_views_human from anon, authenticated;

-- 3. stats functions read the filtered view
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
      from public.page_views_human where ts >= a and ts < b
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
        from public.page_views_human v
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


revoke all on function public.muster_stats(date, date, text) from public, anon;
grant execute on function public.muster_stats(date, date, text) to authenticated;
revoke all on function public.muster_stats_drill(text, date, date, text) from public, anon;
grant execute on function public.muster_stats_drill(text, date, date, text) to authenticated;

notify pgrst, 'reload schema';

-- READ-ONLY before/after check (optional; run separately, changes nothing):
-- select 'all' as src, count(*) filter (where kind = 'load') as visits, count(*) as views, count(distinct (ts::date, visitor)) as visitors from public.page_views
-- union all
-- select 'human', count(*) filter (where kind = 'load'), count(*), count(distinct (ts::date, visitor)) from public.page_views_human;
