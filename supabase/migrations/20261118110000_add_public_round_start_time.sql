begin;

create or replace function public.get_public_tournament_view_with_standings(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_tournament_id text;
  v_revoked_at timestamptz;
  v_archived_at timestamptz;
  v_tournament_data jsonb;
  v_active_round_id text;
  v_round jsonb;
begin
  v_snapshot := public.get_public_tournament_view(p_token);
  if v_snapshot ->> 'status' is distinct from 'active' then
    return v_snapshot;
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

  v_active_round_id := v_tournament_data ->> 'activeRoundId';
  select round_entry.value
    into v_round
  from pg_catalog.jsonb_array_elements(v_tournament_data -> 'rounds')
    as round_entry(value)
  where round_entry.value ->> 'id' = v_active_round_id;

  return v_snapshot || pg_catalog.jsonb_build_object(
    'round_id', v_active_round_id,
    'round_started_at', v_round ->> 'startedAt',
    'standings',
    public.get_commander_tournament_final_standings(v_tournament_data)
  );
end;
$$;

revoke all on function public.get_public_tournament_view_with_standings(text)
  from public, anon, authenticated;

grant execute on function public.get_public_tournament_view_with_standings(text)
  to anon, authenticated;

commit;
