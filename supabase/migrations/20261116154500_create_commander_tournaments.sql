begin;

create table public.commander_tournaments (
  id text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  tournament_data jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint commander_tournaments_data_is_object
    check (pg_catalog.jsonb_typeof(tournament_data) = 'object'),
  constraint commander_tournaments_data_id_matches
    check (tournament_data ->> 'id' = id)
);

create index commander_tournaments_owner_updated_at_idx
  on public.commander_tournaments (owner_id, updated_at desc);

alter table public.commander_tournaments enable row level security;

revoke all on table public.commander_tournaments
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.commander_tournaments
  to authenticated;

create policy "Owners can read their tournaments"
  on public.commander_tournaments
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Owners can create their tournaments"
  on public.commander_tournaments
  for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "Owners can update their tournaments"
  on public.commander_tournaments
  for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "Owners can delete their tournaments"
  on public.commander_tournaments
  for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

create function public.set_commander_tournaments_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

revoke all on function public.set_commander_tournaments_updated_at()
  from public, anon, authenticated;

create trigger commander_tournaments_updated_at
  before update on public.commander_tournaments
  for each row
  execute function public.set_commander_tournaments_updated_at();

commit;
