-- Muster accounts + cloud sync: run once in the Supabase dashboard -> SQL Editor -> New query -> Run.
-- One row per saved list. Deletes are soft (deleted = true, data = null) so other devices drop the list on their next sync.
-- updated_at is the list's own last-edit time from the device (last write wins per list).

create table if not exists public.lists (
  id          text        not null,
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb,
  updated_at  timestamptz not null default now(),
  deleted     boolean     not null default false,
  primary key (user_id, id)
);

create index if not exists lists_user_updated_idx on public.lists (user_id, updated_at);

alter table public.lists enable row level security;

-- each signed-in user can only see and change their own rows
drop policy if exists "lists_select_own" on public.lists;
drop policy if exists "lists_insert_own" on public.lists;
drop policy if exists "lists_update_own" on public.lists;
drop policy if exists "lists_delete_own" on public.lists;
create policy "lists_select_own" on public.lists for select to authenticated using (user_id = auth.uid());
create policy "lists_insert_own" on public.lists for insert to authenticated with check (user_id = auth.uid());
create policy "lists_update_own" on public.lists for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "lists_delete_own" on public.lists for delete to authenticated using (user_id = auth.uid());

-- table privileges for the API roles (RLS above still limits rows). anon may SELECT only so the daily keep-alive ping
-- in .github/workflows/refresh.yml gets a clean 200 – with no anon policy it always sees zero rows.
grant select, insert, update, delete on public.lists to authenticated;
grant select on public.lists to anon;
