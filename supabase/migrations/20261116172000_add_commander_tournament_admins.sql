begin;

create table public.commander_tournament_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

alter table public.commander_tournament_admins enable row level security;

revoke all privileges on table public.commander_tournament_admins
  from public, anon, authenticated;

grant select on table public.commander_tournament_admins to authenticated;

create policy "Accounts can read their own tournament admin assignment"
  on public.commander_tournament_admins
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy "Owners can read their tournaments"
  on public.commander_tournaments;

create policy "Owners and admins can read tournaments"
  on public.commander_tournaments
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.commander_tournament_admins as admins
      where admins.user_id = (select auth.uid())
    )
  );

drop policy "Owners can update their tournaments"
  on public.commander_tournaments;

create policy "Owners and admins can update tournaments"
  on public.commander_tournaments
  for update
  to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.commander_tournament_admins as admins
      where admins.user_id = (select auth.uid())
    )
  )
  with check (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.commander_tournament_admins as admins
      where admins.user_id = (select auth.uid())
    )
  );

drop policy "Owners can delete their tournaments"
  on public.commander_tournaments;

create policy "Owners and admins can delete tournaments"
  on public.commander_tournaments
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.commander_tournament_admins as admins
      where admins.user_id = (select auth.uid())
    )
  );

commit;
