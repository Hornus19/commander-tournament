import { getSupabaseClient } from './supabase'

export type PublicTournamentSnapshot =
  | { status: 'revoked' }
  | { status: 'unavailable' }
  | { status: 'no_active_round'; tournamentName: string }
  | {
      status: 'active'
      tournamentName: string
      format: 'commander' | 'two-headed-giant'
      roundNumber: number
      tables: {
        roundId: string
        podId: string
        tableNumber: number
        players: { id: string; name: string }[]
        proposalStatus: 'pending' | 'approved' | 'rejected' | null
        hasOfficialResult: boolean
      }[]
    }

export type ResultProposal = {
  id: string
  roundId: string
  podId: string
  roundNumber: number
  tableNumber: number
  reporterPlayerId: string
  placements: string[][]
  submittedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isProposalStatus(
  value: unknown,
): value is 'pending' | 'approved' | 'rejected' | null {
  return (
    value === null ||
    value === 'pending' ||
    value === 'approved' ||
    value === 'rejected'
  )
}

function getPublicLinkManagementError(error: unknown, fallback: string) {
  if (isRecord(error) && 'code' in error && error.code === '42501') {
    return 'Solo el propietario del torneo o un administrador verificado puede realizar esta acción.'
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
    !Array.isArray(value.tables) ||
    (value.tournament_format !== undefined &&
      value.tournament_format !== 'commander' &&
      value.tournament_format !== 'two-headed-giant')
  ) {
    throw new Error('Supabase devolvió una vista pública con formato no válido.')
  }

  const tables = value.tables.map((table) => {
    if (
      !isRecord(table) ||
      typeof table.round_id !== 'string' ||
      typeof table.pod_id !== 'string' ||
      typeof table.table_number !== 'number' ||
      !Number.isInteger(table.table_number) ||
      !Array.isArray(table.players) ||
      !isProposalStatus(table.proposal_status) ||
      typeof table.has_official_result !== 'boolean'
    ) {
      throw new Error(
        'Supabase devolvió una vista pública con formato no válido.',
      )
    }
    const players = table.players.map((player) => {
      if (
        !isRecord(player) ||
        typeof player.player_id !== 'string' ||
        typeof player.name !== 'string'
      ) {
        throw new Error(
          'Supabase devolvió una vista pública con formato no válido.',
        )
      }
      return { id: player.player_id, name: player.name }
    })
    return {
      roundId: table.round_id,
      podId: table.pod_id,
      tableNumber: table.table_number,
      players,
      proposalStatus: table.proposal_status,
      hasOfficialResult: table.has_official_result,
    }
  })

  return {
    status: 'active',
    tournamentName: value.tournament_name,
    format:
      value.tournament_format === 'two-headed-giant'
        ? 'two-headed-giant'
        : 'commander',
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

export async function submitPublicTournamentResult(
  token: string,
  roundId: string,
  podId: string,
  tableNumber: number,
  reporterPlayerId: string,
  placements: string[][],
): Promise<void> {
  const { data, error } = await getSupabaseClient().rpc(
    'submit_public_tournament_result',
    {
      p_token: token,
      p_round_id: roundId,
      p_pod_id: podId,
      p_table_number: tableNumber,
      p_reporter_player_id: reporterPlayerId,
      p_placements: placements,
    },
  )

  if (error) {
    throw new Error(
      error.code === 'P0001'
        ? error.message
        : 'No se pudo enviar el resultado. Comprueba los datos e inténtalo de nuevo.',
      { cause: error },
    )
  }
  if (!isRecord(data) || data.status !== 'pending') {
    throw new Error('Supabase no confirmó el envío de la propuesta.')
  }
}

export async function fetchTournamentResultProposals(
  tournamentId: string,
): Promise<ResultProposal[]> {
  const { data, error } = await getSupabaseClient().rpc(
    'get_tournament_result_proposals',
    { p_tournament_id: tournamentId },
  )

  if (error) {
    throw new Error(
      getPublicLinkManagementError(
        error,
        'No se pudieron cargar las propuestas de resultado.',
      ),
      { cause: error },
    )
  }
  if (!Array.isArray(data)) {
    throw new Error(
      'Supabase devolvió una lista de propuestas con formato no válido.',
    )
  }

  return data.map((proposal) => {
    if (
      !isRecord(proposal) ||
      typeof proposal.id !== 'string' ||
      typeof proposal.round_id !== 'string' ||
      typeof proposal.pod_id !== 'string' ||
      typeof proposal.round_number !== 'number' ||
      !Number.isInteger(proposal.round_number) ||
      typeof proposal.table_number !== 'number' ||
      !Number.isInteger(proposal.table_number) ||
      typeof proposal.reporter_player_id !== 'string' ||
      typeof proposal.submitted_at !== 'string' ||
      !Number.isFinite(Date.parse(proposal.submitted_at)) ||
      !Array.isArray(proposal.placements) ||
      !proposal.placements.every(isStringArray)
    ) {
      throw new Error(
        'Supabase devolvió una propuesta de resultado con formato no válido.',
      )
    }

    return {
      id: proposal.id,
      roundId: proposal.round_id,
      podId: proposal.pod_id,
      roundNumber: proposal.round_number,
      tableNumber: proposal.table_number,
      reporterPlayerId: proposal.reporter_player_id,
      placements: proposal.placements,
      submittedAt: proposal.submitted_at,
    }
  })
}

export async function approveTournamentResultProposal(
  proposalId: string,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc(
    'approve_tournament_result_proposal',
    { p_proposal_id: proposalId },
  )

  if (error) {
    throw new Error(
      error.code === 'P0001'
        ? error.message
        : getPublicLinkManagementError(
            error,
            'No se pudo aprobar la propuesta de resultado.',
          ),
      { cause: error },
    )
  }
}

export async function rejectTournamentResultProposal(
  proposalId: string,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc(
    'reject_tournament_result_proposal',
    { p_proposal_id: proposalId },
  )

  if (error) {
    throw new Error(
      error.code === 'P0001'
        ? error.message
        : getPublicLinkManagementError(
            error,
            'No se pudo rechazar la propuesta de resultado.',
          ),
      { cause: error },
    )
  }
}
