-- Muster owner-only Stats: read another account's saved lists (full list data) for the read-only list viewer.
-- NOT applied yet: James must OK it, then run once in the Supabase dashboard -> SQL Editor -> New query -> Run
-- (after supabase/page_views.sql and supabase/stats_drilldown.sql). Safe to re-run (idempotent).
--
-- What it does:
--   muster_stats_lists(p_email): security definer (runs with table-owner rights) but first refuses anyone for whom
--   muster_is_owner() is false. Looks up the account by e-mail in auth.users and returns that account's saved,
--   non-deleted lists from public.lists: [{id, updated_at, data}] (data = the full list JSON as synced), newest first,
--   at most 200. Reads only; writes nothing; returns nothing for an unknown e-mail.
--   Execute granted to signed-in users only (revoked from anon/public); the owner check inside does the rest.
-- The service_role key is never used by the app.

create or replace function public.muster_stats_lists(p_email text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.muster_is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_email is null or char_length(p_email) > 320 then raise exception 'bad e-mail' using errcode = '22023'; end if;
  select u.id into uid from auth.users u where lower(u.email) = lower(p_email) limit 1;
  if uid is null then return '[]'::jsonb; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'updated_at', q.updated_at, 'data', q.data) order by q.updated_at desc), '[]'::jsonb)
    from (select l.id, l.updated_at, l.data from public.lists l
          where l.user_id = uid and not l.deleted order by l.updated_at desc limit 200) q
  );
end;
$$;

revoke all on function public.muster_stats_lists(text) from public, anon;
grant execute on function public.muster_stats_lists(text) to authenticated;

notify pgrst, 'reload schema';
