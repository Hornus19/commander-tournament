import { useCallback, useEffect, useState } from 'react'
import {
  approveTournamentResultProposal,
  fetchTournamentResultProposals,
  rejectTournamentResultProposal,
  type ResultProposal,
} from '../lib/publicTournamentRepository'
import type { Tournament } from '../lib/tournamentStorage'

export default function TournamentResultProposals({
  tournament,
  saving,
  onApproved,
}: {
  tournament: Tournament
  saving: boolean
  onApproved: (proposal: ResultProposal) => void
}) {
  const [proposals, setProposals] = useState<ResultProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const loadProposals = useCallback(async () => {
    try {
      const loaded = await fetchTournamentResultProposals(tournament.id)
      setProposals(loaded)
      setError('')
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'No se pudieron cargar las propuestas de resultado.',
      )
    } finally {
      setLoading(false)
    }
  }, [tournament.id])

  useEffect(() => {
    let active = true
    void fetchTournamentResultProposals(tournament.id)
      .then((loaded) => {
        if (active) {
          setProposals(loaded)
          setError('')
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'No se pudieron cargar las propuestas de resultado.',
          )
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [tournament.id])

  async function decide(proposal: ResultProposal, approve: boolean) {
    if (busyProposalId || saving) {
      return
    }

    setBusyProposalId(proposal.id)
    setError('')
    try {
      if (approve) {
        await approveTournamentResultProposal(proposal.id)
        onApproved(proposal)
      } else {
        await rejectTournamentResultProposal(proposal.id)
      }
      await loadProposals()
    } catch (decisionError: unknown) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : approve
            ? 'No se pudo aprobar la propuesta.'
            : 'No se pudo rechazar la propuesta.',
      )
    } finally {
      setBusyProposalId(null)
    }
  }

  const playersById = new Map(
    tournament.players.map((player) => [player.id, player.name]),
  )

  return (
    <section
      aria-labelledby="result-proposals-heading"
      className="mt-8 border-t border-white/10 pt-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="app-kicker text-sm font-semibold text-amber-300">
            Aprobación del organizador
          </p>
          <h2 id="result-proposals-heading">Propuestas de resultado</h2>
        </div>
        <button
          className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
          disabled={loading || busyProposalId !== null}
          onClick={() => void loadProposals()}
          type="button"
        >
          Actualizar propuestas
        </button>
      </div>
      {error && (
        <p
          className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
          role="alert"
        >
          {error}
        </p>
      )}
      {loading ? (
        <p
          aria-live="polite"
          className="mt-4 text-sm text-slate-300"
          role="status"
        >
          Cargando propuestas…
        </p>
      ) : proposals.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-700 px-4 py-4 text-sm text-slate-400">
          No hay propuestas pendientes.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {proposals.map((proposal) => (
            <li
              className="rounded-xl border border-slate-700 bg-slate-950/50 p-4"
              key={proposal.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-100">
                    Ronda {proposal.roundNumber} · Mesa {proposal.tableNumber}
                  </h3>
                  <p className="mt-1 text-sm text-slate-300">
                    {tournament.format === 'two-headed-giant'
                      ? 'Informa la pareja:'
                      : 'Informa:'}{' '}
                    {playersById.get(proposal.reporterPlayerId) ??
                      'Jugador que ya no está en la lista'}
                  </p>
                  <time
                    className="mt-1 block text-xs text-slate-400"
                    dateTime={proposal.submittedAt}
                  >
                    {new Intl.DateTimeFormat('es', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(proposal.submittedAt))}
                  </time>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="rounded-lg bg-emerald-400/15 px-3 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-400/25 disabled:cursor-wait disabled:opacity-50"
                    disabled={busyProposalId !== null || saving}
                    onClick={() => void decide(proposal, true)}
                    type="button"
                  >
                    {busyProposalId === proposal.id
                      ? 'Guardando…'
                      : 'Aprobar'}
                  </button>
                  <button
                    className="rounded-lg border border-rose-400/40 px-3 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-400/10 disabled:cursor-wait disabled:opacity-50"
                    disabled={busyProposalId !== null || saving}
                    onClick={() => void decide(proposal, false)}
                    type="button"
                  >
                    Rechazar
                  </button>
                </div>
              </div>
              <ol className="mt-3 space-y-1">
                {proposal.placements.map((placement, index) => {
                  const place = proposal.placements
                    .slice(0, index)
                    .reduce((total, previous) => total + previous.length, 1)
                  return (
                    <li
                      className="text-sm text-slate-300"
                      key={`${proposal.id}-place-${index}`}
                    >
                      <span className="font-medium text-slate-100">
                        {tournament.format === 'two-headed-giant'
                          ? proposal.placements.length === 1
                            ? 'Empate · 2 puntos'
                            : index === 0
                              ? 'Gana · 4 puntos'
                              : 'Pierde · 0 puntos'
                          : `${place}.º puesto`}
                      </span>
                      {' — '}
                      {placement
                        .map(
                          (playerId) =>
                            playersById.get(playerId) ??
                            'Jugador que ya no está en la lista',
                        )
                        .join(', ')}
                    </li>
                  )
                })}
              </ol>
              <p className="mt-3 text-xs text-amber-200">
                La aprobación actualizará el resultado oficial de esta mesa.
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
