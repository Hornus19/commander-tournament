import type { TournamentFormat } from './tournamentStorage'

export type PlacementValidation =
  | { valid: true; placements: string[][] }
  | { valid: false; error: string }

export function buildPlacementsFromRanks(
  playerIds: string[],
  ranksByPlayerId: Record<string, string>,
  format: TournamentFormat = 'commander',
): PlacementValidation {
  const supportedSize =
    format === 'two-headed-giant'
      ? playerIds.length === 2
      : playerIds.length === 3 || playerIds.length === 4
  if (!supportedSize) {
    return {
      valid: false,
      error:
        format === 'two-headed-giant'
          ? 'Solo se pueden registrar resultados para una mesa de 2 parejas.'
          : 'Solo se pueden registrar resultados para pods de 3 o 4 jugadores.',
    }
  }
  if (new Set(playerIds).size !== playerIds.length) {
    return {
      valid: false,
      error: 'La mesa contiene jugadores duplicados y no admite resultados.',
    }
  }

  if (format === 'two-headed-giant') {
    const outcomes = playerIds.map((playerId) => ranksByPlayerId[playerId])
    if (outcomes.every((outcome) => outcome === 'draw')) {
      return { valid: true, placements: [[...playerIds]] }
    }
    if (
      outcomes.filter((outcome) => outcome === 'win').length === 1 &&
      outcomes.filter((outcome) => outcome === 'loss').length === 1
    ) {
      return {
        valid: true,
        placements: [
          playerIds.filter((playerId) => ranksByPlayerId[playerId] === 'win'),
          playerIds.filter((playerId) => ranksByPlayerId[playerId] === 'loss'),
        ],
      }
    }
    return {
      valid: false,
      error:
        'Selecciona una pareja ganadora y otra perdedora, o marca empate para las dos.',
    }
  }

  const playersByPlace = new Map<number, string[]>()
  for (const playerId of playerIds) {
    const rank = ranksByPlayerId[playerId]
    const place = Number(rank)
    if (
      typeof rank !== 'string' ||
      rank === '' ||
      !Number.isInteger(place) ||
      place < 1 ||
      place > playerIds.length
    ) {
      return {
        valid: false,
        error: 'Asigna un puesto a cada jugador antes de enviar el resultado.',
      }
    }
    playersByPlace.set(place, [
      ...(playersByPlace.get(place) ?? []),
      playerId,
    ])
  }

  let expectedPlace = 1
  const validPlacements = [...playersByPlace.keys()]
    .sort((first, second) => first - second)
    .every((place) => {
      if (place !== expectedPlace) {
        return false
      }
      expectedPlace += (playersByPlace.get(place) ?? []).length
      return true
    })

  if (!validPlacements || expectedPlace !== playerIds.length + 1) {
    return {
      valid: false,
      error:
        'Revisa los puestos: tras un empate, el siguiente puesto avanza según las personas empatadas.',
    }
  }

  return {
    valid: true,
    placements: [...playersByPlace.entries()]
      .sort(([firstPlace], [secondPlace]) => firstPlace - secondPlace)
      .map(([, tiedPlayerIds]) => tiedPlayerIds),
  }
}
