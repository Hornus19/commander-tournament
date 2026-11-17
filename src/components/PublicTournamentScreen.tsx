import { useEffect, useState } from 'react'
import {
  fetchPublicTournament,
  type PublicTournamentSnapshot,
} from '../lib/publicTournamentRepository'

export default function PublicTournamentScreen({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<PublicTournamentSnapshot | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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
  }, [token])

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
                {snapshot.tables.map((table) => (
                  <li
                    className="rounded-xl border border-slate-700 bg-slate-950/60 p-4"
                    key={table.tableNumber}
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
                        {table.players.map((player, index) => (
                          <li
                            className="text-sm text-slate-200"
                            key={`${table.tableNumber}-${index}`}
                          >
                            {player}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
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
