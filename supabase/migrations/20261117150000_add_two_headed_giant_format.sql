begin;

create or replace function public.submit_public_tournament_result(
  p_token text,
  p_round_id text,
  p_pod_id text,
  p_table_number integer,
  p_reporter_player_id text,
  p_placements jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tournament_id text;
  v_archived_at timestamptz;
  v_tournament_data jsonb;
  v_active_round_id text;
  v_round jsonb;
  v_round_id text;
  v_round_number integer;
  v_pod jsonb;
  v_pod_id text;
  v_table_number integer;
  v_pod_player_ids text[];
  v_submitted_player_ids text[] := array[]::text[];
  v_sorted_player_ids text[];
  v_placement jsonb;
  v_player_id_json jsonb;
  v_player_id text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'El enlace público no es válido o ha sido revocado.'
      using errcode = 'P0001';
  end if;
  if p_table_number is null or p_table_number < 1 then
    raise exception 'La mesa seleccionada no es válida.'
      using errcode = 'P0001';
  end if;
  if p_placements is null
    or pg_catalog.jsonb_typeof(p_placements) is distinct from 'array'
  then
    raise exception 'Asigna un puesto a cada jugador antes de enviar el resultado.'
      using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_array_length(p_placements) = 0 then
    raise exception 'Asigna un puesto a cada jugador antes de enviar el resultado.'
      using errcode = 'P0001';
  end if;

  select link.tournament_id
    into v_tournament_id
  from public.commander_tournament_public_links as link
  where link.token = p_token
    and link.revoked_at is null;

  if not found then
    raise exception 'El enlace público no es válido o ha sido revocado.'
      using errcode = 'P0001';
  end if;

  select tournament.archived_at, tournament.tournament_data
    into v_archived_at, v_tournament_data
  from public.commander_tournaments as tournament
  where tournament.id = v_tournament_id
  for update;

  if not found or v_archived_at is not null then
    raise exception 'No se pueden enviar resultados para un torneo archivado.'
      using errcode = 'P0001';
  end if;

  v_active_round_id := v_tournament_data ->> 'activeRoundId';
  select round_entry.value, round_entry.ordinality::integer
    into v_round, v_round_number
  from pg_catalog.jsonb_array_elements(v_tournament_data -> 'rounds')
    with ordinality as round_entry(value, ordinality)
  where round_entry.value ->> 'id' = v_active_round_id;

  if not found or pg_catalog.jsonb_typeof(v_round -> 'pods') is distinct from 'array' then
    raise exception 'No hay una ronda activa válida para este torneo.'
      using errcode = 'P0001';
  end if;
  if p_round_id is distinct from v_active_round_id then
    raise exception 'La ronda mostrada por el QR ya no está activa. Actualiza el tablero e inténtalo de nuevo.'
      using errcode = 'P0001';
  end if;

  select pod_entry.value, pod_entry.ordinality::integer
    into v_pod, v_table_number
  from pg_catalog.jsonb_array_elements(v_round -> 'pods')
    with ordinality as pod_entry(value, ordinality)
  where pod_entry.ordinality = p_table_number
    and pod_entry.value ->> 'id' = p_pod_id;

  if not found
    or pg_catalog.jsonb_typeof(v_pod -> 'playerIds') is distinct from 'array'
  then
    raise exception 'La mesa mostrada por el QR cambió. Actualiza el tablero e inténtalo de nuevo.'
      using errcode = 'P0001';
  end if;

  v_round_id := v_round ->> 'id';
  v_pod_id := v_pod ->> 'id';
  if (v_pod ? 'result') and v_pod -> 'result' <> 'null'::jsonb then
    raise exception 'Esta mesa ya tiene un resultado oficial y no admite nuevas propuestas.'
      using errcode = 'P0001';
  end if;

  select pg_catalog.array_agg(player_id.value order by player_id.value)
    into v_pod_player_ids
  from pg_catalog.jsonb_array_elements_text(v_pod -> 'playerIds')
    as player_id(value);

  if v_tournament_data ->> 'format' = 'two-headed-giant' then
    if coalesce(pg_catalog.cardinality(v_pod_player_ids), 0) <> 2
      or pg_catalog.cardinality(v_pod_player_ids) <>
        (select pg_catalog.count(distinct player_id.value)::integer
         from pg_catalog.jsonb_array_elements_text(v_pod -> 'playerIds')
           as player_id(value))
    then
      raise exception 'Esta mesa debe tener exactamente 2 parejas únicas.'
        using errcode = 'P0001';
    end if;
  elsif coalesce(pg_catalog.cardinality(v_pod_player_ids), 0) not in (3, 4)
    or pg_catalog.cardinality(v_pod_player_ids) <>
      (select pg_catalog.count(distinct player_id.value)::integer
       from pg_catalog.jsonb_array_elements_text(v_pod -> 'playerIds')
         as player_id(value))
  then
    raise exception 'Esta mesa no tiene 3 o 4 jugadores únicos.'
      using errcode = 'P0001';
  end if;

  if not (p_reporter_player_id = any(v_pod_player_ids)) then
    raise exception 'Quien informa debe ser un jugador de esta mesa.'
      using errcode = 'P0001';
  end if;

  for v_placement in
    select placement.value
    from pg_catalog.jsonb_array_elements(p_placements) as placement(value)
  loop
    if pg_catalog.jsonb_typeof(v_placement) is distinct from 'array'
    then
      raise exception 'Los puestos enviados no son válidos.'
        using errcode = 'P0001';
    end if;
    if pg_catalog.jsonb_array_length(v_placement) = 0 then
      raise exception 'Los puestos enviados no son válidos.'
        using errcode = 'P0001';
    end if;

    for v_player_id_json in
      select player_id.value
      from pg_catalog.jsonb_array_elements(v_placement) as player_id(value)
    loop
      if pg_catalog.jsonb_typeof(v_player_id_json) is distinct from 'string' then
        raise exception 'Los jugadores enviados no son válidos.'
          using errcode = 'P0001';
      end if;
      v_player_id := v_player_id_json #>> '{}';
      if v_player_id = any(v_submitted_player_ids) then
        raise exception 'Cada jugador debe aparecer exactamente una vez.'
          using errcode = 'P0001';
      end if;
      v_submitted_player_ids :=
        pg_catalog.array_append(v_submitted_player_ids, v_player_id);
    end loop;
  end loop;

  select pg_catalog.array_agg(player_id order by player_id)
    into v_sorted_player_ids
  from pg_catalog.unnest(v_submitted_player_ids) as player_id;

  if v_sorted_player_ids is distinct from v_pod_player_ids then
    raise exception 'Los puestos deben incluir exactamente a los jugadores de esta mesa.'
      using errcode = 'P0001';
  end if;

  if v_tournament_data ->> 'format' = 'two-headed-giant'
    and not (
      (
        pg_catalog.jsonb_array_length(p_placements) = 1
        and pg_catalog.jsonb_array_length(p_placements -> 0) = 2
      )
      or (
        pg_catalog.jsonb_array_length(p_placements) = 2
        and pg_catalog.jsonb_array_length(p_placements -> 0) = 1
        and pg_catalog.jsonb_array_length(p_placements -> 1) = 1
      )
    )
  then
    raise exception 'Indica una pareja ganadora y otra perdedora, o empate para ambas.'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_tournament_data -> 'players')
      as player(value)
    where player.value ->> 'id' = p_reporter_player_id
  ) then
    raise exception 'Quien informa ya no pertenece al torneo.'
      using errcode = 'P0001';
  end if;

  insert into public.commander_tournament_result_proposals (
    tournament_id,
    round_id,
    pod_id,
    round_number,
    table_number,
    reported_by_player_id,
    player_ids_snapshot,
    placements
  )
  values (
    v_tournament_id,
    v_round_id,
    v_pod_id,
    v_round_number,
    v_table_number,
    p_reporter_player_id,
    pg_catalog.to_jsonb(v_pod_player_ids),
    p_placements
  )
  on conflict (tournament_id, round_id, pod_id)
    where status = 'pending'
  do nothing;

  if not found then
    raise exception 'Ya hay una propuesta pendiente para esta mesa.'
      using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object('status', 'pending');
end;
$$;

create or replace function public.get_public_tournament_view(p_token text)
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
  v_round_id text;
  v_round_number integer;
  v_pod jsonb;
  v_pod_id text;
  v_table_number integer;
  v_table_players jsonb;
  v_proposal_status text;
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
  if v_active_round_id is null
    or pg_catalog.jsonb_typeof(v_tournament_data -> 'rounds') is distinct from 'array'
  then
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
  v_round_id := v_round ->> 'id';

  for v_pod, v_table_number in
    select pod_entry.value, pod_entry.ordinality::integer
    from pg_catalog.jsonb_array_elements(v_round -> 'pods')
      with ordinality as pod_entry(value, ordinality)
  loop
    v_pod_id := v_pod ->> 'id';
    v_table_players := '[]'::jsonb;
    if pg_catalog.jsonb_typeof(v_pod -> 'playerIds') = 'array' then
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'player_id', player_id.value,
            'name', player.value -> 'name'
          )
          order by player_id.ordinality
        ),
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

    select proposal.status
      into v_proposal_status
    from public.commander_tournament_result_proposals as proposal
    where proposal.tournament_id = v_tournament_id
      and proposal.round_id = v_round_id
      and proposal.pod_id = v_pod_id
    order by
      (proposal.status = 'pending') desc,
      proposal.submitted_at desc,
      proposal.id desc
    limit 1;

    v_tables := v_tables || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'round_id', v_round_id,
        'pod_id', v_pod_id,
        'table_number', v_table_number,
        'players', v_table_players,
        'proposal_status', v_proposal_status,
        'has_official_result',
          (v_pod ? 'result') and v_pod -> 'result' <> 'null'::jsonb
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'status', 'active',
    'tournament_name', v_tournament_name,
    'round_number', v_round_number,
    'tournament_format', coalesce(v_tournament_data ->> 'format', 'commander'),
    'tables', v_tables
  );
end;
$$;

commit;
