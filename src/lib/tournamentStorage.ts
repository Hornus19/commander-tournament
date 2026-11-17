export type Player = {
  id: string
  name: string
}

export type TournamentFormat = 'commander' | 'two-headed-giant'

export type PodResult = {
  placements: string[][]
}

export type Pod = {
  id: string
  playerIds: string[]
  result?: PodResult
}

export type TournamentRound = {
  id: string
  pods: Pod[]
}

export type Tournament = {
  id: string
  name: string
  format: TournamentFormat
  date: string
  location: string
  players: Player[]
  rounds: TournamentRound[]
  activeRoundId?: string
  closedAt?: string
}

const LEGACY_STORAGE_KEY = 'commander-tournament:tournaments'
const USER_STORAGE_KEY_PREFIX = `${LEGACY_STORAGE_KEY}:`
type StoredTournament = Omit<Tournament, 'rounds' | 'format'> & {
  rounds?: TournamentRound[]
  format?: TournamentFormat
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPlayer(value: unknown): value is Player {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string'
  )
}

function isPod(value: unknown, format: TournamentFormat): value is Pod {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.playerIds) &&
    value.playerIds.length <= 4 &&
    value.playerIds.every((playerId) => typeof playerId === 'string') &&
    (value.result === undefined ||
      isPodResult(value.result, value.playerIds, format))
  )
}

function isPodResult(
  value: unknown,
  podPlayerIds: unknown[],
  format: TournamentFormat,
): value is PodResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.placements) ||
    (format === 'two-headed-giant'
      ? podPlayerIds.length !== 2
      : podPlayerIds.length !== 3 && podPlayerIds.length !== 4) ||
    !value.placements.every(
      (placement) =>
        Array.isArray(placement) &&
        placement.length > 0 &&
        placement.every((playerId) => typeof playerId === 'string'),
    )
  ) {
    return false
  }

  const resultPlayerIds = value.placements.flat()
  const includesAllPlayers =
    resultPlayerIds.length === podPlayerIds.length &&
    new Set(resultPlayerIds).size === resultPlayerIds.length &&
    resultPlayerIds.every((playerId) => podPlayerIds.includes(playerId))

  if (!includesAllPlayers) {
    return false
  }

  if (format === 'two-headed-giant') {
    return (
      (value.placements.length === 1 &&
        value.placements[0].length === 2) ||
      (value.placements.length === 2 &&
        value.placements.every((placement) => placement.length === 1))
    )
  }

  return true
}

function isTournamentRound(
  value: unknown,
  format: TournamentFormat,
): value is TournamentRound {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.pods) &&
    value.pods.every((pod) => isPod(pod, format))
  )
}

function isTournament(value: unknown): value is StoredTournament {
  if (!(
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.format === undefined ||
      value.format === 'commander' ||
      value.format === 'two-headed-giant') &&
    typeof value.date === 'string' &&
    typeof value.location === 'string' &&
    Array.isArray(value.players) &&
    value.players.every(isPlayer) &&
    (value.activeRoundId === undefined ||
      typeof value.activeRoundId === 'string') &&
    (value.closedAt === undefined ||
      (typeof value.closedAt === 'string' &&
        Number.isFinite(Date.parse(value.closedAt)))) &&
    (value.rounds === undefined ||
      (Array.isArray(value.rounds) &&
        value.rounds.every((round) =>
          isTournamentRound(
            round,
            value.format === 'two-headed-giant'
              ? 'two-headed-giant'
              : 'commander',
          ),
        )))
  )) {
    return false
  }

  const playerIds = new Set(value.players.map((player) => player.id))
  const format = value.format ?? 'commander'
  return value.rounds === undefined || value.rounds.every((round) => {
    const assignedPlayerIds = round.pods.flatMap((pod) => pod.playerIds)
    return (
      (format !== 'two-headed-giant' ||
        round.pods.every((pod) => pod.playerIds.length <= 2)) &&
      assignedPlayerIds.every((playerId) => playerIds.has(playerId)) &&
      new Set(assignedPlayerIds).size === assignedPlayerIds.length
    )
  })
}

function parseTournaments(storedValue: string): Tournament[] | null {
  const parsed: unknown = JSON.parse(storedValue)
  if (!Array.isArray(parsed) || !parsed.every(isTournament)) {
    return null
  }

  return parsed.map((tournament) => normalizeTournament(tournament))
}

function normalizeTournament(tournament: StoredTournament): Tournament {
  return {
    ...tournament,
    format: tournament.format ?? 'commander',
    rounds: tournament.rounds ?? [],
  }
}

export function parseTournamentData(value: unknown): Tournament | null {
  return isTournament(value) ? normalizeTournament(value) : null
}

function getUserStorageKey(userId: string) {
  return `${USER_STORAGE_KEY_PREFIX}${userId}`
}

export function loadTournaments(userId: string): Tournament[] {
  try {
    const storedValue = window.localStorage.getItem(getUserStorageKey(userId))
    if (storedValue === null) {
      return []
    }

    const tournaments = parseTournaments(storedValue)
    if (tournaments === null) {
      console.warn('Los datos guardados de torneos no tienen un formato válido.')
      return []
    }

    return tournaments
  } catch (error) {
    console.warn('No se pudieron recuperar los torneos guardados.', error)
    return []
  }
}

export function readTournamentsForSync(userId: string): Tournament[] {
  let storedValue: string | null
  try {
    storedValue = window.localStorage.getItem(getUserStorageKey(userId))
  } catch (error) {
    throw new Error('No se pudieron leer los torneos locales de esta cuenta.', {
      cause: error,
    })
  }

  if (storedValue === null) {
    return []
  }

  try {
    const tournaments = parseTournaments(storedValue)
    if (tournaments === null) {
      throw new Error('Los datos locales de torneos tienen un formato no válido.')
    }
    return tournaments
  } catch (error) {
    throw new Error('No se pudieron validar los torneos locales de esta cuenta.', {
      cause: error,
    })
  }
}

export function migrateLegacyTournaments(userId: string): Tournament[] {
  try {
    const storage = window.localStorage
    const userStorageKey = getUserStorageKey(userId)
    const existingUserData = storage.getItem(userStorageKey)

    if (existingUserData !== null) {
      return parseTournaments(existingUserData) ?? []
    }

    const legacyData = storage.getItem(LEGACY_STORAGE_KEY)
    if (legacyData === null) {
      return []
    }

    const tournaments = parseTournaments(legacyData)
    if (tournaments === null) {
      console.warn('Los datos antiguos de torneos no tienen un formato válido.')
      return []
    }

    const migratedData = JSON.stringify(tournaments)
    storage.setItem(userStorageKey, migratedData)
    if (storage.getItem(userStorageKey) !== migratedData) {
      console.warn('No se pudo verificar la copia de los torneos antiguos.')
      return []
    }

    storage.removeItem(LEGACY_STORAGE_KEY)
    return tournaments
  } catch (error) {
    console.warn('No se pudieron migrar los torneos antiguos.', error)
    return []
  }
}

export function saveTournaments(
  userId: string,
  tournaments: Tournament[],
): boolean {
  try {
    window.localStorage.setItem(
      getUserStorageKey(userId),
      JSON.stringify(tournaments),
    )
    return true
  } catch (error) {
    console.warn('No se pudieron guardar los torneos en este dispositivo.', error)
    return false
  }
}
