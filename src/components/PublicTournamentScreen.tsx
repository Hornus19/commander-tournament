import { useEffect, useState, type FormEvent } from 'react'
import {
  fetchPublicTournament,
  submitPublicTournamentResult,
  type PublicTournamentSnapshot,
} from '../lib/publicTournamentRepository'
import { buildPlacementsFromRanks } from '../lib/podPlacements'

export default function PublicTournamentScreen({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<PublicTournamentSnapshot | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openTablePodId, setOpenTablePodId] = useState<string | null>(null)
  const [reporterByTable, setReporterByTable] = useState<
    Record<string, string>
  >({})
  const [ranksByTable, setRanksByTable] = useState<
    Record<string, Record<string, string>>
  >({})
  const [proposalErrors, setProposalErrors] = useState<Record<string, string>>(
    {},
  )
  const [sendingPodId, setSendingPodId] = useState<string | null>(null)
  const [submittedTable, setSubmittedTable] = useState<{
    roundId: string
    podId: string
  } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  async function sendResult(
    event: FormEvent<HTMLFormElement>,
    table: Extract<PublicTournamentSnapshot, { status: 'active' }>['tables'][number],
  ) {
    event.preventDefault()
    const reporterPlayerId = reporterByTable[table.podId] ?? ''
    if (
      !reporterPlayerId ||
      !table.players.some(({ id }) => id === reporterPlayerId)
    ) {
      setProposalErrors((current) => ({
        ...current,
        [table.podId]: 'Elige quién informa del resultado.',
      }))
      return
    }

    const validation = buildPlacementsFromRanks(
      table.players.map(({ id }) => id),
      ranksByTable[table.podId] ?? {},
    )
    if (!validation.valid) {
      setProposalErrors((current) => ({
        ...current,
        [table.podId]: validation.error,
      }))
      return
    }

    setSendingPodId(table.podId)
    setProposalErrors((current) => ({ ...current, [table.podId]: '' }))
    try {
      await submitPublicTournamentResult(
        token,
        table.roundId,
        table.podId,
        table.tableNumber,
        reporterPlayerId,
        validation.placements,
      )
      setSubmittedTable({ roundId: table.roundId, podId: table.podId })
      setOpenTablePodId(null)
      setRefreshKey((current) => current + 1)
    } catch (submitError: unknown) {
      setProposalErrors((current) => ({
        ...current,
        [table.podId]:
          submitError instanceof Error
            ? submitError.message
            : 'No se pudo enviar el resultado.',
      }))
    } finally {
      setSendingPodId(null)
    }
  }

  useEffect(() => {
    let active = true
    let requestInProgress = false

    async function refresh() {
      if (requestInProgress) {
        return
      }
      requestInProgress = true
      try {
        const nextSnapshot = await fetchPublicTournament(token)
        if (active) {
          setSnapshot(nextSnapshot)
          setSubmittedTable((current) => {
            if (!current || nextSnapshot.status !== 'active') {
              return current
            }
            const submitted = nextSnapshot.tables.find(
              (table) =>
                table.roundId === current.roundId &&
                table.podId === current.podId,
            )
            return submitted?.proposalStatus ? null : current
          })
          setError('')
        }
      } catch {
        if (active) {
          setError(
            'No se pudo actualizar el tablero público. Se volverá a intentar automáticamente.',
          )
        }
      } finally {
        if (active) {
          setLoading(false)
        }
        requestInProgress = false
      }
    }

    void refresh()
    const intervalId = window.setInterval(() => void refresh(), 10_000)
    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [token, refreshKey])

  return (
    <main className="app-shell min-h-screen px-4 py-8 sm:px-8 sm:py-12">
      <section
        aria-labelledby="public-tournament-heading"
        className="mx-auto w-full max-w-4xl rounded-2xl border border-white/10 bg-slate-900/90 p-5 shadow-xl shadow-black/20 sm:p-8"
      >
        <p className="app-kicker text-sm font-semibold text-amber-300">
          Commander Tournament
        </p>
        {error && (
          <p
            className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
            role="alert"
          >
            {error}
          </p>
        )}
        {loading && !snapshot ? (
          <p
            aria-live="polite"
            className="mt-5 text-sm text-slate-300"
            role="status"
          >
            Cargando tablero público…
          </p>
        ) : snapshot?.status === 'revoked' ? (
          <div className="mt-5">
            <h1 id="public-tournament-heading">Enlace no disponible</h1>
            <p className="mt-3 text-slate-300">
              Este enlace público se ha revocado o ya no existe.
            </p>
          </div>
        ) : snapshot?.status === 'unavailable' ? (
          <div className="mt-5">
            <h1 id="public-tournament-heading">Tablero no disponible</h1>
            <p className="mt-3 text-slate-300">
              No se puede mostrar el tablero de este torneo en este momento.
            </p>
          </div>
        ) : snapshot?.status === 'no_active_round' ? (
          <div className="mt-5">
            <h1 id="public-tournament-heading">{snapshot.tournamentName}</h1>
            <p className="mt-3 text-slate-300">
              El organizador aún no ha elegido una ronda para mostrar en el QR.
            </p>
          </div>
        ) : snapshot?.status === 'active' ? (
          <div className="mt-5">
            <h1 id="public-tournament-heading">{snapshot.tournamentName}</h1>
            <h2 className="mt-2 text-lg font-semibold text-amber-100">
              Ronda {snapshot.roundNumber}
            </h2>
            {snapshot.tables.length === 0 ? (
              <p className="mt-5 rounded-lg border border-dashed border-slate-700 px-4 py-5 text-sm text-slate-300">
                Esta ronda todavía no tiene mesas.
              </p>
            ) : (
              <ul className="mt-5 grid gap-4 sm:grid-cols-2">
                {snapshot.tables.map((table) => {
                  const isLocallyPending =
                    submittedTable?.roundId === table.roundId &&
                    submittedTable.podId === table.podId
                  const proposalStatus = isLocallyPending
                    ? 'pending'
                    : table.proposalStatus
                  return (
                    <li
                      className="rounded-xl border border-slate-700 bg-slate-950/60 p-4"
                      key={`${table.roundId}-${table.podId}`}
                    >
                      <h3 className="font-semibold text-amber-100">
                        Mesa {table.tableNumber}
                      </h3>
                      {table.players.length === 0 ? (
                        <p className="mt-3 text-sm text-slate-400">
                          Aún no hay jugadores asignados.
                        </p>
                      ) : (
                        <ul className="mt-3 space-y-2">
                          {table.players.map((player) => (
                            <li
                              className="text-sm text-slate-200"
                              key={player.id}
                            >
                              {player.name}
                            </li>
                          ))}
                        </ul>
                      )}
                      {proposalStatus === 'pending' ? (
                        <p
                          className="mt-3 text-sm text-amber-200"
                          role="status"
                        >
                          Resultado pendiente de aprobación del organizador.
                        </p>
                      ) : proposalStatus === 'approved' ? (
                        <p
                          className="mt-3 text-sm text-emerald-200"
                          role="status"
                        >
                          Resultado aprobado por el organizador.
                        </p>
                      ) : proposalStatus === 'rejected' ? (
                        <p
                          className="mt-3 text-sm text-rose-200"
                          role="status"
                        >
                          Resultado rechazado por el organizador.
                        </p>
                      ) : null}
                      {table.hasOfficialResult && (
                        <p
                          className="mt-3 text-sm text-emerald-200"
                          role="status"
                        >
                          Esta mesa ya tiene un resultado oficial.
                        </p>
                      )}
                      {openTablePodId === table.podId &&
                      !table.hasOfficialResult &&
                      proposalStatus !== 'pending' &&
                      table.players.length >= 3 &&
                      table.players.length <= 4 ? (
                        <form
                          className="mt-4 space-y-3 border-t border-white/10 pt-4"
                          onSubmit={(event) => void sendResult(event, table)}
                        >
                          <div>
                            <label
                              className="mb-1 block text-sm font-medium text-slate-200"
                              htmlFor={`reporter-${table.podId}`}
                            >
                              Quién informa
                            </label>
                            <select
                              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"
                              id={`reporter-${table.podId}`}
                              onChange={(event) =>
                                setReporterByTable((current) => ({
                                  ...current,
                                  [table.podId]: event.target.value,
                                }))
                              }
                              required
                              value={reporterByTable[table.podId] ?? ''}
                            >
                              <option value="">Selecciona un jugador</option>
                              {table.players.map((player) => (
                                <option key={player.id} value={player.id}>
                                  {player.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          {table.players.map((player) => (
                            <div
                              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                              key={player.id}
                            >
                              <label
                                className="min-w-0 truncate text-sm text-slate-200"
                                htmlFor={`place-${table.podId}-${player.id}`}
                              >
                                {player.name}
                              </label>
                              <select
                                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                                id={`place-${table.podId}-${player.id}`}
                                onChange={(event) =>
                                  setRanksByTable((current) => ({
                                    ...current,
                                    [table.podId]: {
                                      ...current[table.podId],
                                      [player.id]: event.target.value,
                                    },
                                  }))
                                }
                                required
                                value={
                                  ranksByTable[table.podId]?.[player.id] ?? ''
                                }
                              >
                                <option value="">Puesto</option>
                                {table.players.map((_, placeIndex) => (
                                  <option
                                    key={placeIndex + 1}
                                    value={placeIndex + 1}
                                  >
                                    {placeIndex + 1}.º puesto
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                          {proposalErrors[table.podId] && (
                            <p className="text-sm text-rose-300" role="alert">
                              {proposalErrors[table.podId]}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <button
                              className="rounded-lg bg-amber-300 px-3 py-2 text-sm font-semibold text-slate-950 disabled:cursor-wait disabled:opacity-50"
                              disabled={sendingPodId !== null}
                              type="submit"
                            >
                              {sendingPodId === table.podId
                                ? 'Enviando…'
                                : 'Enviar propuesta'}
                            </button>
                            <button
                              className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200"
                              disabled={sendingPodId !== null}
                              onClick={() => setOpenTablePodId(null)}
                              type="button"
                            >
                              Cancelar
                            </button>
                          </div>
                        </form>
                      ) : !table.hasOfficialResult &&
                      proposalStatus !== 'pending' &&
                      table.players.length >= 3 &&
                      table.players.length <= 4 ? (
                        <button
                          className="mt-4 rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-300/10"
                          onClick={() => {
                            setProposalErrors((current) => ({
                              ...current,
                              [table.podId]: '',
                            }))
                            setOpenTablePodId(table.podId)
                          }}
                          type="button"
                        >
                          Enviar resultado
                        </button>
                      ) : !table.hasOfficialResult &&
                        proposalStatus !== 'pending' ? (
                        <p className="mt-4 text-sm text-slate-400">
                          Esta mesa no tiene 3 o 4 jugadores y no admite
                          resultados.
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : !error ? (
          <p
            aria-live="polite"
            className="mt-5 text-sm text-slate-300"
            role="status"
          >
            Cargando tablero público…
          </p>
        ) : null}
      </section>
    </main>
  )
}
