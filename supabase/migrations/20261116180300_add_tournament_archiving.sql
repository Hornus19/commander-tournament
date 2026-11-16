begin;

alter table public.commander_tournaments
  add column archived_at timestamptz;

create function public.prevent_non_admin_tournament_archiving()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.archived_at is distinct from old.archived_at
    and not exists (
      select 1
      from public.commander_tournament_admins as admins
      where admins.user_id = (select auth.uid())
    )
  then
    raise exception 'Only a tournament admin can change archived_at'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all privileges
  on function public.prevent_non_admin_tournament_archiving()
  from public, anon, authenticated;

create trigger commander_tournaments_prevent_non_admin_archiving
  before update of archived_at on public.commander_tournaments
  for each row
  execute function public.prevent_non_admin_tournament_archiving();

commit;
