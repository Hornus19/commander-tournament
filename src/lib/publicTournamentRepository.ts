import { getSupabaseClient } from './supabase'

export type PublicTournamentSnapshot =
  | { status: 'revoked' }
  | { status: 'unavailable' }
  | { status: 'no_active_round'; tournamentName: string }
  | {
      status: 'active'
      tournamentName: string
      roundNumber: number
      tables: { tableNumber: number; players: string[] }[]
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function getPublicLinkManagementError(error: unknown, fallback: string) {
  if (isRecord(error) && 'code' in error && error.code === '42501') {
    return 'Solo el propietario o un administrador verificado puede gestionar el enlace público. Sincroniza primero el torneo si aún no existe en Supabase.'
  }
  return fallback
}

function parsePublicTournamentSnapshot(
  value: unknown,
): PublicTournamentSnapshot {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('Supabase devolvió una vista pública con formato no válido.')
  }
  if (value.status === 'revoked') {
    return { status: 'revoked' }
  }
  if (value.status === 'unavailable') {
    return { status: 'unavailable' }
  }
  if (
    typeof value.tournament_name !== 'string' ||
    (value.status !== 'active' && value.status !== 'no_active_round')
  ) {
    throw new Error('Supabase devolvió una vista pública con formato no válido.')
  }
  if (value.status === 'no_active_round') {
    return {
      status: 'no_active_round',
      tournamentName: value.tournament_name,
    }
  }
  if (
    typeof value.round_number !== 'number' ||
    !Number.isInteger(value.round_number) ||
    !Array.isArray(value.tables)
  ) {
    throw new Error('Supabase devolvió una vista pública con formato no válido.')
  }

  const tables = value.tables.map((table) => {
    if (
      !isRecord(table) ||
      typeof table.table_number !== 'number' ||
      !Number.isInteger(table.table_number) ||
      !isStringArray(table.players)
    ) {
      throw new Error(
        'Supabase devolvió una vista pública con formato no válido.',
      )
    }
    return {
      tableNumber: table.table_number,
      players: table.players,
    }
  })

  return {
    status: 'active',
    tournamentName: value.tournament_name,
    roundNumber: value.round_number,
    tables,
  }
}

export async function getPublicTournamentLink(
  tournamentId: string,
): Promise<string | null> {
  const { data, error } = await getSupabaseClient().rpc(
    'get_public_tournament_link',
    { p_tournament_id: tournamentId },
  )

  if (error) {
    throw new Error(
      getPublicLinkManagementError(
        error,
        'No se pudo consultar el enlace público del torneo.',
      ),
      { cause: error },
    )
  }
  if (
    data !== null &&
    (typeof data !== 'string' || !/^[0-9a-f]{64}$/i.test(data))
  ) {
    throw new Error('Supabase devolvió un enlace público con formato no válido.')
  }
  return data
}

export async function createPublicTournamentLink(
  tournamentId: string,
): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc(
    'create_public_tournament_link',
    { p_tournament_id: tournamentId },
  )

  if (error) {
    throw new Error(
      getPublicLinkManagementError(
        error,
        'No se pudo crear el enlace público del torneo.',
      ),
      { cause: error },
    )
  }
  if (typeof data !== 'string' || !/^[0-9a-f]{64}$/i.test(data)) {
    throw new Error('Supabase devolvió un enlace público con formato no válido.')
  }
  return data
}

export async function revokePublicTournamentLink(
  tournamentId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc(
    'revoke_public_tournament_link',
    { p_tournament_id: tournamentId },
  )

  if (error) {
    throw new Error(
      getPublicLinkManagementError(
        error,
        'No se pudo revocar el enlace público del torneo.',
      ),
      { cause: error },
    )
  }
  if (typeof data !== 'boolean') {
    throw new Error('Supabase devolvió una respuesta de revocación no válida.')
  }
  return data
}

export async function fetchPublicTournament(
  token: string,
): Promise<PublicTournamentSnapshot> {
  const { data, error } = await getSupabaseClient().rpc(
    'get_public_tournament_view',
    { p_token: token },
  )

  if (error) {
    throw new Error('No se pudo cargar el tablero público del torneo.', {
      cause: error,
    })
  }
  return parsePublicTournamentSnapshot(data)
}
