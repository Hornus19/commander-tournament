import { getSupabaseClient } from './supabase'
import {
  parseTournamentData,
  type Tournament,
} from './tournamentStorage'

export type TournamentRecord = {
  tournament: Tournament
  updatedAt: string
  ownerId: string
  archivedAt: string | null
}

type TournamentUpsertRow = {
  id: string
  owner_id: string
  tournament_data: Tournament
}

const TOURNAMENT_COLUMNS =
  'id, owner_id, tournament_data, updated_at, archived_at'
const AUTO_SYNC_METADATA_KEY = 'commander_tournament_auto_sync'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTournamentRow(value: unknown): TournamentRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.owner_id !== 'string' ||
    typeof value.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    (value.archived_at !== null &&
      (typeof value.archived_at !== 'string' ||
        !Number.isFinite(Date.parse(value.archived_at))))
  ) {
    throw new Error('Supabase devolvió un registro de torneo con formato no válido.')
  }

  const tournament = parseTournamentData(value.tournament_data)
  if (!tournament || tournament.id !== value.id) {
    throw new Error(
      'Supabase devolvió datos de torneo no válidos o con un identificador incoherente.',
    )
  }

  return {
    tournament,
    updatedAt: value.updated_at,
    ownerId: value.owner_id,
    archivedAt: value.archived_at,
  }
}

export async function fetchTournaments(
  userId: string,
): Promise<TournamentRecord[]> {
  const { data, error } = await getSupabaseClient()
    .from('commander_tournaments')
    .select(TOURNAMENT_COLUMNS)
    .eq('owner_id', userId)
    .order('updated_at', { ascending: false })

  if (error) {
    throw new Error('No se pudieron leer los torneos de la cuenta.', {
      cause: error,
    })
  }

  const rows: unknown = data
  if (!Array.isArray(rows)) {
    throw new Error('Supabase devolvió una lista de torneos con formato no válido.')
  }

  return rows.map(parseTournamentRow)
}

export async function fetchAllTournamentsForAdmin(): Promise<
  TournamentRecord[]
> {
  const { data, error } = await getSupabaseClient()
    .from('commander_tournaments')
    .select(TOURNAMENT_COLUMNS)
    .order('updated_at', { ascending: false })

  if (error) {
    throw new Error('No se pudieron leer los torneos para el panel admin.', {
      cause: error,
    })
  }

  const rows: unknown = data
  if (!Array.isArray(rows)) {
    throw new Error('Supabase devolvió una lista de torneos con formato no válido.')
  }

  return rows.map(parseTournamentRow)
}

export async function hasTournamentAdminAccess(
  userId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .from('commander_tournament_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw new Error('No se pudo comprobar el acceso de administrador.', {
      cause: error,
    })
  }

  return data !== null
}

export async function updateAutomaticSyncPreference(
  enabled: boolean,
): Promise<void> {
  const client = getSupabaseClient()
  const { data, error } = await client.auth.getUser()

  if (error) {
    throw new Error('No se pudo recuperar la configuración de la cuenta.', {
      cause: error,
    })
  }

  const { error: updateError } = await client.auth.updateUser({
    data: {
      ...data.user.user_metadata,
      [AUTO_SYNC_METADATA_KEY]: enabled,
    },
  })

  if (updateError) {
    throw new Error(
      'No se pudo guardar la preferencia de sincronización automática.',
      { cause: updateError },
    )
  }
}

export async function saveTournamentsToSupabase(
  userId: string,
  tournaments: Tournament[],
): Promise<void> {
  if (tournaments.length === 0) {
    return
  }

  const rows: TournamentUpsertRow[] = tournaments.map((tournament) => ({
    id: tournament.id,
    owner_id: userId,
    tournament_data: tournament,
  }))

  const { error } = await getSupabaseClient()
    .from('commander_tournaments')
    .upsert(rows, { onConflict: 'id' })

  if (error) {
    throw new Error('No se pudieron guardar los torneos de la cuenta.', {
      cause: error,
    })
  }
}

export async function saveAdminTournament(
  tournament: Tournament,
  ownerId: string,
): Promise<void> {
  const { data, error } = await getSupabaseClient()
    .from('commander_tournaments')
    .update({ tournament_data: tournament })
    .eq('id', tournament.id)
    .eq('owner_id', ownerId)
    .is('archived_at', null)
    .select('id')
    .maybeSingle()

  if (error) {
    throw new Error('No se pudieron guardar los cambios del torneo.', {
      cause: error,
    })
  }
  if (!data) {
    throw new Error(
      'El torneo ya no está activo o no se pudo actualizar. No se guardaron los cambios.',
    )
  }
}

export async function setTournamentArchived(
  tournamentId: string,
  archived: boolean,
): Promise<string | null> {
  const archivedAt = archived ? new Date().toISOString() : null
  const { data, error } = await getSupabaseClient()
    .from('commander_tournaments')
    .update({ archived_at: archivedAt })
    .eq('id', tournamentId)
    .select('archived_at')
    .maybeSingle()

  if (error) {
    throw new Error(
      archived
        ? 'No se pudo archivar el torneo.'
        : 'No se pudo restaurar el torneo.',
      { cause: error },
    )
  }
  if (!data) {
    throw new Error(
      'El torneo no existe o no tienes permiso para cambiar su estado.',
    )
  }

  return data.archived_at
}
