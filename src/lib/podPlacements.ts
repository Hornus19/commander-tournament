export type PlacementValidation =
  | { valid: true; placements: string[][] }
  | { valid: false; error: string }

export function buildPlacementsFromRanks(
  playerIds: string[],
  ranksByPlayerId: Record<string, string>,
): PlacementValidation {
  if (playerIds.length !== 3 && playerIds.length !== 4) {
    return {
      valid: false,
      error: 'Solo se pueden registrar resultados para pods de 3 o 4 jugadores.',
    }
  }
  if (new Set(playerIds).size !== playerIds.length) {
    return {
      valid: false,
      error: 'La mesa contiene jugadores duplicados y no admite resultados.',
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
