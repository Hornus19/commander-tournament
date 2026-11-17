begin;

create table public.commander_tournament_public_links (
  tournament_id text primary key
    references public.commander_tournaments (id) on delete cascade,
  token text not null unique
    check (token ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz
);

alter table public.commander_tournament_public_links enable row level security;

revoke all privileges on table public.commander_tournament_public_links
  from public, anon, authenticated;

create function public.get_public_tournament_link(p_tournament_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text;
begin
  if v_user_id is null or not exists (
    select 1
    from public.commander_tournaments as tournament
    where tournament.id = p_tournament_id
      and (
        tournament.owner_id = v_user_id
        or exists (
          select 1
          from public.commander_tournament_admins as admins
          where admins.user_id = v_user_id
        )
      )
  ) then
    raise exception 'Not authorized to manage this tournament link'
      using errcode = '42501';
  end if;

  select link.token
    into v_token
  from public.commander_tournament_public_links as link
  where link.tournament_id = p_tournament_id
    and link.revoked_at is null;

  return v_token;
end;
$$;

create function public.create_public_tournament_link(p_tournament_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_archived_at timestamptz;
  v_token text;
begin
  if v_user_id is null or not exists (
    select 1
    from public.commander_tournaments as tournament
    where tournament.id = p_tournament_id
      and (
        tournament.owner_id = v_user_id
        or exists (
          select 1
          from public.commander_tournament_admins as admins
          where admins.user_id = v_user_id
        )
      )
  ) then
    raise exception 'Not authorized to manage this tournament link'
      using errcode = '42501';
  end if;

  select tournament.archived_at
    into v_archived_at
  from public.commander_tournaments as tournament
  where tournament.id = p_tournament_id;

  if not found or v_archived_at is not null then
    raise exception 'Cannot create a public link for an archived tournament'
      using errcode = '55000';
  end if;

  v_token :=
    pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into public.commander_tournament_public_links (
    tournament_id,
    token,
    created_by,
    created_at,
    revoked_at
  )
  values (
    p_tournament_id,
    v_token,
    v_user_id,
    pg_catalog.now(),
    null
  )
  on conflict (tournament_id)
  do update set
    token = excluded.token,
    created_by = excluded.created_by,
    created_at = excluded.created_at,
    revoked_at = null;

  return v_token;
end;
$$;

create function public.revoke_public_tournament_link(p_tournament_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not exists (
    select 1
    from public.commander_tournaments as tournament
    where tournament.id = p_tournament_id
      and (
        tournament.owner_id = v_user_id
        or exists (
          select 1
          from public.commander_tournament_admins as admins
          where admins.user_id = v_user_id
        )
      )
  ) then
    raise exception 'Not authorized to manage this tournament link'
      using errcode = '42501';
  end if;

  update public.commander_tournament_public_links as link
  set revoked_at = pg_catalog.now()
  where link.tournament_id = p_tournament_id
    and link.revoked_at is null;

  return found;
end;
$$;

create function public.get_public_tournament_view(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tournament_id text;
  v_revoked_at timestamptz;
  v_archived_at timestamptz;
  v_tournament_data jsonb;
  v_tournament_name text;
  v_active_round_id text;
  v_round jsonb;
  v_round_number integer;
  v_pod jsonb;
  v_table_number integer;
  v_table_players jsonb;
  v_tables jsonb := '[]'::jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('status', 'revoked');
  end if;

  select link.tournament_id, link.revoked_at
    into v_tournament_id, v_revoked_at
  from public.commander_tournament_public_links as link
  where link.token = p_token;

  if not found or v_revoked_at is not null then
    return pg_catalog.jsonb_build_object('status', 'revoked');
  end if;

  select tournament.archived_at, tournament.tournament_data
    into v_archived_at, v_tournament_data
  from public.commander_tournaments as tournament
  where tournament.id = v_tournament_id;

  if not found or v_archived_at is not null then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;

  if pg_catalog.jsonb_typeof(v_tournament_data -> 'name') is distinct from 'string'
    or pg_catalog.jsonb_typeof(v_tournament_data -> 'players') is distinct from 'array'
  then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;

  v_tournament_name := v_tournament_data ->> 'name';
  v_active_round_id := v_tournament_data ->> 'activeRoundId';
  if v_active_round_id is null then
    return pg_catalog.jsonb_build_object(
      'status', 'no_active_round',
      'tournament_name', v_tournament_name
    );
  end if;

  if pg_catalog.jsonb_typeof(v_tournament_data -> 'rounds') is distinct from 'array' then
    return pg_catalog.jsonb_build_object(
      'status', 'no_active_round',
      'tournament_name', v_tournament_name
    );
  end if;

  select round_entry.value, round_entry.ordinality::integer
    into v_round, v_round_number
  from pg_catalog.jsonb_array_elements(v_tournament_data -> 'rounds')
    with ordinality as round_entry(value, ordinality)
  where round_entry.value ->> 'id' = v_active_round_id;

  if not found
    or pg_catalog.jsonb_typeof(v_round -> 'pods') is distinct from 'array'
  then
    return pg_catalog.jsonb_build_object(
      'status', 'no_active_round',
      'tournament_name', v_tournament_name
    );
  end if;

  for v_pod, v_table_number in
    select pod_entry.value, pod_entry.ordinality::integer
    from pg_catalog.jsonb_array_elements(v_round -> 'pods')
      with ordinality as pod_entry(value, ordinality)
  loop
    v_table_players := '[]'::jsonb;
    if pg_catalog.jsonb_typeof(v_pod -> 'playerIds') = 'array' then
      select coalesce(
        pg_catalog.jsonb_agg(player.value -> 'name' order by player_id.ordinality),
        '[]'::jsonb
      )
        into v_table_players
      from pg_catalog.jsonb_array_elements_text(v_pod -> 'playerIds')
        with ordinality as player_id(value, ordinality)
      join pg_catalog.jsonb_array_elements(v_tournament_data -> 'players')
        as player(value)
        on player.value ->> 'id' = player_id.value
      where pg_catalog.jsonb_typeof(player.value -> 'name') = 'string';
    end if;

    v_tables := v_tables || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'table_number', v_table_number,
        'players', v_table_players
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'status', 'active',
    'tournament_name', v_tournament_name,
    'round_number', v_round_number,
    'tables', v_tables
  );
end;
$$;

revoke all on function public.get_public_tournament_link(text)
  from public, anon, authenticated;
revoke all on function public.create_public_tournament_link(text)
  from public, anon, authenticated;
revoke all on function public.revoke_public_tournament_link(text)
  from public, anon, authenticated;
revoke all on function public.get_public_tournament_view(text)
  from public, anon, authenticated;

grant execute on function public.get_public_tournament_link(text)
  to authenticated;
grant execute on function public.create_public_tournament_link(text)
  to authenticated;
grant execute on function public.revoke_public_tournament_link(text)
  to authenticated;
grant execute on function public.get_public_tournament_view(text)
  to anon, authenticated;

commit;
