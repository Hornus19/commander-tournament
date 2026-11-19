import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import {
  fetchTournamentResultProposals,
  type ResultProposal,
} from './lib/publicTournamentRepository'
import {
  migrateLegacyTournaments,
  readTournamentsForSync,
  saveTournaments,
  type Pod,
  type PodResult,
  type Tournament,
  type TournamentFormat,
  type TournamentRound,
} from './lib/tournamentStorage'
import { getSupabaseClient } from './lib/supabase'
import {
  fetchAllTournamentsForAdmin,
  fetchTournaments,
  hasTournamentAdminAccess,
  saveAdminTournament,
  deleteTournamentFromSupabase,
  saveTournamentsToSupabase,
  setTournamentArchived,
  updateAutomaticSyncPreference,
  type TournamentRecord,
} from './lib/tournamentRepository'
import { buildPlacementsFromRanks } from './lib/podPlacements'
import './App.css'

const PublicTournamentManager = lazy(
  () => import('./components/PublicTournamentManager'),
)
const PublicTournamentScreen = lazy(
  () => import('./components/PublicTournamentScreen'),
)
const TournamentResultProposals = lazy(
  () => import('./components/TournamentResultProposals'),
)

type TournamentConflict = {
  id: string
  local: Tournament
  remote: Tournament
  choice: 'local' | 'remote' | null
}

type SyncReview = {
  localTournaments: Tournament[]
  remoteRecords: TournamentRecord[]
  conflicts: TournamentConflict[]
  automatic: boolean
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)

  return `{${entries.join(',')}}`
}

function sameTournament(first: Tournament, second: Tournament) {
  return canonicalJson(first) === canonicalJson(second)
}

function getSyncErrorMessage(error: unknown) {
  if (
    error instanceof Error &&
    error.message.startsWith('Supabase is not configured.')
  ) {
    return 'Supabase no está configurado. Revisa las variables de entorno antes de sincronizar.'
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'No se pudieron sincronizar los torneos. Tus datos locales se conservaron.'
}

function downloadTournamentBackup(tournament: Tournament) {
  const exportedAt = new Date()
  const safeTournamentName =
    tournament.name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'torneo'
  const backup = {
    app: 'Commander Tournament',
    backupVersion: 1,
    exportedAt: exportedAt.toISOString(),
    tournament,
  }
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  })
  const downloadUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = `${safeTournamentName}-copia-${exportedAt
    .toISOString()
    .slice(0, 10)}.json`
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
}

function sameTournamentList(first: Tournament[], second: Tournament[]) {
  if (first.length !== second.length) {
    return false
  }

  const secondById = new Map(second.map((tournament) => [tournament.id, tournament]))
  return first.every((tournament) => {
    const counterpart = secondById.get(tournament.id)
    return counterpart !== undefined && sameTournament(tournament, counterpart)
  })
}

function createSyncReview(
  localTournaments: Tournament[],
  remoteRecords: TournamentRecord[],
  automatic = false,
): SyncReview {
  const remoteById = new Map(
    remoteRecords.map(({ tournament }) => [tournament.id, tournament]),
  )
  const conflicts = localTournaments.flatMap((local) => {
    const remoteRecord = remoteRecords.find(
      (record) => record.tournament.id === local.id,
    )
    const remote =
      remoteRecord?.archivedAt === null ? remoteById.get(local.id) : undefined
    return remote && !sameTournament(local, remote)
      ? [{ id: local.id, local, remote, choice: null }]
      : []
  })
  return { localTournaments, remoteRecords, conflicts, automatic }
}

function combineTournaments(review: SyncReview): Tournament[] | null {
  if (review.conflicts.some(({ choice }) => choice === null)) {
    return null
  }

  const conflictsById = new Map(
    review.conflicts.map((conflict) => [conflict.id, conflict]),
  )
  const archivedIds = new Set(
    review.remoteRecords
      .filter(({ archivedAt }) => archivedAt !== null)
      .map(({ tournament }) => tournament.id),
  )
  const combined = review.localTournaments.flatMap((local) => {
    if (archivedIds.has(local.id)) {
      return []
    }
    const conflict = conflictsById.get(local.id)
    return [
      conflict
        ? conflict.choice === 'remote'
          ? conflict.remote
          : conflict.local
        : local,
    ]
  })
  const localIds = new Set(review.localTournaments.map(({ id }) => id))
  review.remoteRecords.forEach(({ tournament, archivedAt }) => {
    if (!localIds.has(tournament.id) && archivedAt === null) {
      combined.push(tournament)
    }
  })
  return combined
}

function sameRemoteRecords(
  first: TournamentRecord[],
  second: TournamentRecord[],
) {
  if (first.length !== second.length) {
    return false
  }
  const secondById = new Map(
    second.map((record) => [record.tournament.id, record]),
  )
  return first.every((record) => {
    const counterpart = secondById.get(record.tournament.id)
    return (
      counterpart !== undefined &&
      record.ownerId === counterpart.ownerId &&
      record.archivedAt === counterpart.archivedAt &&
      sameTournament(record.tournament, counterpart.tournament)
    )
  })
}

type AuthState = {
  status:
    | 'loading'
    | 'signed-out'
    | 'signed-in'
    | 'password-recovery'
    | 'error'
  session: Session | null
  client: SupabaseClient | null
  error: string
}

function AdminPanel({
  onOpenTournament,
}: {
  onOpenTournament: (record: TournamentRecord) => void
}) {
  const [records, setRecords] = useState<TournamentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyTournamentId, setBusyTournamentId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void fetchAllTournamentsForAdmin()
      .then((loadedRecords) => {
        if (active) {
          setRecords(loadedRecords)
          setLoading(false)
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'No se pudieron cargar los torneos para administración.',
          )
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  async function changeArchiveState(
    record: TournamentRecord,
    archived: boolean,
  ) {
    if (
      busyTournamentId ||
      (archived &&
        !window.confirm(
          `¿Quieres archivar el torneo «${record.tournament.name}»?`,
        ))
    ) {
      return
    }

    setBusyTournamentId(record.tournament.id)
    setError('')
    try {
      const archivedAt = await setTournamentArchived(
        record.tournament.id,
        archived,
      )
      setRecords((current) =>
        current.map((currentRecord) =>
          currentRecord.tournament.id === record.tournament.id
            ? { ...currentRecord, archivedAt }
            : currentRecord,
        ),
      )
    } catch (archiveError) {
      setError(
        archiveError instanceof Error
          ? archiveError.message
          : archived
            ? 'No se pudo archivar el torneo.'
            : 'No se pudo restaurar el torneo.',
      )
    } finally {
      setBusyTournamentId(null)
    }
  }

  const activeRecords = records.filter(({ archivedAt }) => archivedAt === null)
  const archivedRecords = records.filter(({ archivedAt }) => archivedAt !== null)

  function renderRecords(
    title: string,
    list: TournamentRecord[],
    archived: boolean,
  ) {
    return (
      <section aria-label={title}>
        <h4 className="mb-3 text-base font-semibold text-slate-100">{title}</h4>
        {list.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 px-4 py-4 text-sm text-slate-400">
            No hay torneos {archived ? 'archivados' : 'activos'}.
          </p>
        ) : (
          <ul className="space-y-2">
            {list.map((record) => (
              <li
                className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950/50 p-4 sm:flex-row sm:items-center sm:justify-between"
                key={record.tournament.id}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-100">
                    {record.tournament.name}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Propietario: <code>{record.ownerId.slice(0, 8)}…</code>
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {!archived && (
                    <button
                      className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10"
                      onClick={() => onOpenTournament(record)}
                      type="button"
                    >
                      Gestionar
                    </button>
                  )}
                  <button
                    className="rounded-lg border border-amber-300/40 px-3 py-2 text-sm text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-wait disabled:opacity-50"
                    disabled={busyTournamentId !== null}
                    onClick={() =>
                      void changeArchiveState(record, !archived)
                    }
                    type="button"
                  >
                    {busyTournamentId === record.tournament.id
                      ? 'Guardando…'
                      : archived
                        ? 'Restaurar'
                        : 'Archivar'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  return (
    <section
      aria-labelledby="admin-panel-heading"
      className="mt-8 rounded-2xl border border-amber-300/20 bg-slate-900/80 p-5 shadow-lg shadow-black/10 sm:p-7"
    >
      <p className="app-kicker text-sm font-semibold text-amber-300">
        Administración
      </p>
      <h2 id="admin-panel-heading">Torneos de todas las cuentas</h2>
      {error && (
        <p
          className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
          role="alert"
        >
          {error}
        </p>
      )}
      {loading ? (
        <p aria-live="polite" className="mt-4 text-sm text-slate-300" role="status">
          Cargando torneos…
        </p>
      ) : (
        <div className="mt-6 space-y-7">
          {renderRecords('Torneos activos', activeRecords, false)}
          {renderRecords('Torneos archivados', archivedRecords, true)}
        </div>
      )}
    </section>
  )
}

function getAuthErrorMessage(error: unknown) {
  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return 'No se pudo completar la solicitud. Inténtalo de nuevo.'
  }

  const message = String(error.message).toLowerCase()
  if (
    message.includes('otp_expired') ||
    message.includes('expired') ||
    message.includes('invalid token')
  ) {
    return 'El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo desde la pantalla de acceso.'
  }
  if (message.includes('invalid login credentials')) {
    return 'El correo o la contraseña no son correctos.'
  }
  if (message.includes('email not confirmed')) {
    return 'Confirma tu correo electrónico antes de iniciar sesión.'
  }
  if (message.includes('user already registered')) {
    return 'Ya existe una cuenta con ese correo. Inicia sesión.'
  }
  if (message.includes('password should be at least')) {
    return 'La contraseña no cumple los requisitos mínimos.'
  }
  if (message.includes('rate limit') || message.includes('too many requests')) {
    return 'Se han realizado demasiados intentos. Espera un momento y vuelve a probar.'
  }
  if (message.includes('fetch') || message.includes('network')) {
    return 'No se pudo conectar con el servicio de autenticación. Comprueba tu conexión.'
  }
  return 'No se pudo completar la solicitud. Comprueba los datos e inténtalo de nuevo.'
}

function clearPasswordRecoveryRedirect() {
  const url = new URL(window.location.href)
  url.searchParams.delete('password-recovery')
  url.hash = ''
  window.history.replaceState(
    {},
    document.title,
    `${url.pathname}${url.search}`,
  )
}

type AuthScreenMode =
  | 'sign-in'
  | 'sign-up'
  | 'forgot-password'
  | 'update-password'

function AuthScreen({
  client,
  initialError,
  initialMode = 'sign-in',
  onRecoveryComplete,
}: {
  client: SupabaseClient | null
  initialError: string
  initialMode?: AuthScreenMode
  onRecoveryComplete?: () => void
}) {
  const [mode, setMode] = useState<AuthScreenMode>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [notice, setNotice] = useState('')
  const [passwordUpdated, setPasswordUpdated] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!client || busy) {
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'forgot-password') {
        const redirectTo = new URL('/', window.location.origin)
        redirectTo.searchParams.set('password-recovery', '1')
        const { error: recoveryError } = await client.auth.resetPasswordForEmail(
          email.trim(),
          { redirectTo: redirectTo.toString() },
        )
        if (recoveryError) {
          setError(getAuthErrorMessage(recoveryError))
        } else {
          setNotice(
            'Si existe una cuenta con ese correo, recibirá un enlace para restablecer la contraseña. Revisa también la carpeta de spam.',
          )
        }
      } else if (mode === 'update-password') {
        if (password !== confirmPassword) {
          setError('Las contraseñas no coinciden.')
          return
        }
        const { error: updateError } = await client.auth.updateUser({
          password,
        })
        if (updateError) {
          setError(getAuthErrorMessage(updateError))
        } else {
          setPassword('')
          setConfirmPassword('')
          setPasswordUpdated(true)
          setNotice('La contraseña se ha actualizado correctamente.')
        }
      } else if (mode === 'sign-up') {
        const { data, error: signUpError } = await client.auth.signUp({
          email: email.trim(),
          password,
        })
        if (signUpError) {
          setError(getAuthErrorMessage(signUpError))
        } else if (!data.session) {
          setNotice(
            'Cuenta creada. Revisa tu correo y confirma la dirección para activar la cuenta. Después, inicia sesión.',
          )
        }
      } else {
        const { error: signInError } = await client.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (signInError) {
          setError(getAuthErrorMessage(signInError))
        }
      }
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError))
    } finally {
      setPassword('')
      setConfirmPassword('')
      setBusy(false)
    }
  }

  function changeMode(nextMode: 'sign-in' | 'sign-up') {
    setMode(nextMode)
    setError('')
    setNotice('')
    setPassword('')
    setConfirmPassword('')
    setPasswordUpdated(false)
  }

  function changeRecoveryMode(nextMode: 'sign-in' | 'forgot-password') {
    setMode(nextMode)
    setError('')
    setNotice('')
    setPassword('')
    setConfirmPassword('')
    setPasswordUpdated(false)
  }

  return (
    <main className="app-shell flex min-h-screen items-center px-4 py-10 sm:px-8">
      <section
        aria-labelledby="auth-heading"
        className="mx-auto w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/90 p-6 shadow-xl shadow-black/20 sm:p-8"
      >
        <div className="mb-5 flex items-center gap-3">
          <img
            alt=""
            aria-hidden="true"
            className="size-12 shrink-0 rounded-xl shadow-lg shadow-black/30"
            src="/icons/commander-mark.svg"
          />
          <p className="app-kicker text-sm font-semibold text-amber-300">
            Commander Tournament
          </p>
        </div>
        <h1 className="mb-2!" id="auth-heading">
          {mode === 'sign-in'
            ? 'Iniciar sesión'
            : mode === 'sign-up'
              ? 'Crear cuenta'
              : mode === 'forgot-password'
                ? 'Recuperar contraseña'
                : 'Nueva contraseña'}
        </h1>
        <p className="app-supporting-copy mb-6! text-sm text-slate-400">
          {mode === 'sign-in'
            ? 'Accede para ver y gestionar tus torneos.'
            : mode === 'sign-up'
              ? 'Crea una cuenta para empezar a organizar tus torneos.'
              : mode === 'forgot-password'
                ? 'Escribe el correo de tu cuenta y te enviaremos un enlace de recuperación.'
                : 'Elige una contraseña nueva para volver a acceder a tu cuenta.'}
        </p>

        {error && (
          <p
            className="mb-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
            role="alert"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            className="mb-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100"
            role="status"
          >
            {notice}
          </p>
        )}

        {mode === 'update-password' && passwordUpdated ? (
          <button
            className="w-full rounded-lg bg-amber-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-amber-200"
            onClick={onRecoveryComplete}
            type="button"
          >
            Continuar a la aplicación
          </button>
        ) : (
          <form className="space-y-5" onSubmit={submit}>
            {mode !== 'update-password' && (
              <div>
                <label
                  className="mb-2 block text-sm font-medium text-slate-200"
                  htmlFor="auth-email"
                >
                  Correo electrónico
                </label>
                <input
                  autoComplete="email"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white"
                  disabled={!client || busy}
                  id="auth-email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                />
              </div>
            )}
            {mode !== 'forgot-password' && (
              <div>
                <label
                  className="mb-2 block text-sm font-medium text-slate-200"
                  htmlFor="auth-password"
                >
                  {mode === 'update-password'
                    ? 'Nueva contraseña'
                    : 'Contraseña'}
                </label>
                <input
                  autoComplete={
                    mode === 'sign-up' || mode === 'update-password'
                      ? 'new-password'
                      : 'current-password'
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white"
                  disabled={!client || busy}
                  id="auth-password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </div>
            )}
            {mode === 'update-password' && (
              <div>
                <label
                  className="mb-2 block text-sm font-medium text-slate-200"
                  htmlFor="auth-confirm-password"
                >
                  Repite la nueva contraseña
                </label>
                <input
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white"
                  disabled={!client || busy}
                  id="auth-confirm-password"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  type="password"
                  value={confirmPassword}
                />
              </div>
            )}
            <button
              className="w-full rounded-lg bg-amber-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-wait disabled:opacity-60"
              disabled={!client || busy}
              type="submit"
            >
              {busy
                ? 'Un momento…'
                : mode === 'sign-in'
                  ? 'Iniciar sesión'
                  : mode === 'sign-up'
                    ? 'Crear cuenta'
                    : mode === 'forgot-password'
                      ? 'Enviar enlace'
                      : 'Guardar nueva contraseña'}
            </button>
          </form>
        )}

        {mode === 'sign-in' && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
            <button
              className="rounded font-semibold text-amber-200 underline decoration-amber-200/50 underline-offset-4 hover:text-amber-100"
              onClick={() => changeRecoveryMode('forgot-password')}
              type="button"
            >
              ¿Olvidaste tu contraseña?
            </button>
            <span className="text-slate-400">¿No tienes cuenta?</span>
            <button
              className="rounded font-semibold text-amber-200 underline decoration-amber-200/50 underline-offset-4 hover:text-amber-100"
              onClick={() => changeMode('sign-up')}
              type="button"
            >
              Crear cuenta
            </button>
          </div>
        )}
        {mode === 'sign-up' && (
          <p className="mt-6 text-center text-sm text-slate-400">
            ¿Ya tienes cuenta?{' '}
            <button
              className="rounded font-semibold text-amber-200 underline decoration-amber-200/50 underline-offset-4 hover:text-amber-100"
              onClick={() => changeMode('sign-in')}
              type="button"
            >
              Iniciar sesión
            </button>
          </p>
        )}
        {mode === 'forgot-password' && (
          <p className="mt-6 text-center text-sm text-slate-400">
            ¿Ya recordaste la contraseña?{' '}
            <button
              className="rounded font-semibold text-amber-200 underline decoration-amber-200/50 underline-offset-4 hover:text-amber-100"
              onClick={() => changeRecoveryMode('sign-in')}
              type="button"
            >
              Volver a iniciar sesión
            </button>
          </p>
        )}
      </section>
    </main>
  )
}

function getPodPoints(
  result: PodResult,
  playerCount: number,
  format: TournamentFormat,
) {
  const pointsByPosition = playerCount === 4 ? [4, 3, 2, 0] : [4, 2, 0]
  const points = new Map<string, number>()

  if (format === 'two-headed-giant') {
    if (result.placements.length === 1) {
      result.placements[0].forEach((teamId) => points.set(teamId, 2))
      return points
    }
    result.placements[0]?.forEach((teamId) => points.set(teamId, 4))
    result.placements[1]?.forEach((teamId) => points.set(teamId, 0))
    return points
  }

  if (result.placements.length === 1) {
    result.placements[0].forEach((playerId) => points.set(playerId, 1))
    return points
  }

  let firstPosition = 0
  result.placements.forEach((placement) => {
    const pointsForPlacement =
      pointsByPosition[firstPosition + placement.length - 1]
    placement.forEach((playerId) => points.set(playerId, pointsForPlacement))
    firstPosition += placement.length
  })

  return points
}

function getTournamentStandings(tournament: Tournament) {
  const pointsByPlayer = new Map<string, number>(
    tournament.players.map(({ id }) => [id, 0] as const),
  )

  for (const round of tournament.rounds) {
    for (const pod of round.pods) {
      if (!pod.result) {
        continue
      }
      for (const [playerId, points] of getPodPoints(
        pod.result,
        pod.playerIds.length,
        tournament.format,
      )) {
        if (pointsByPlayer.has(playerId)) {
          pointsByPlayer.set(
            playerId,
            (pointsByPlayer.get(playerId) ?? 0) + points,
          )
        }
      }
    }
  }

  const sortedPlayers = tournament.players
    .map((player) => ({
      ...player,
      points: pointsByPlayer.get(player.id) ?? 0,
    }))
    .sort(
      (first, second) =>
        second.points - first.points ||
        first.name.localeCompare(second.name, 'es'),
    )

  let previousPoints: number | null = null
  let previousPosition = 0
  return sortedPlayers.map((player, index) => {
    const position =
      player.points === previousPoints ? previousPosition : index + 1
    previousPoints = player.points
    previousPosition = position
    return { ...player, position }
  })
}

function getPodParticipantPrintResult(
  pod: Pod,
  playerId: string,
  format: TournamentFormat,
) {
  if (!pod.result) {
    return 'Pendiente'
  }

  const placementIndex = pod.result.placements.findIndex((placement) =>
    placement.includes(playerId),
  )
  if (placementIndex < 0) {
    return '—'
  }

  const position =
    1 +
    pod.result.placements
      .slice(0, placementIndex)
      .reduce((total, placement) => total + placement.length, 0)
  const points = getPodPoints(pod.result, pod.playerIds.length, format).get(
    playerId,
  ) ?? 0
  const resultLabel =
    format === 'two-headed-giant'
      ? pod.result.placements.length === 1
        ? 'Empate'
        : placementIndex === 0
          ? 'Gana'
          : 'Pierde'
      : `${position}.º`

  return `${resultLabel} · ${points} pt`
}

function getBalancedPodSizes(
  playerCount: number,
  format: TournamentFormat,
): number[] | null {
  if (format === 'two-headed-giant') {
    if (playerCount < 2 || playerCount % 2 !== 0) {
      return null
    }
    return Array.from({ length: playerCount / 2 }, () => 2)
  }

  const podCount = Math.ceil(playerCount / 4)
  if (podCount === 0) {
    return null
  }

  const smallestPodSize = Math.floor(playerCount / podCount)
  const largerPodCount = playerCount % podCount
  const sizes = Array.from({ length: podCount }, (_, index) =>
    smallestPodSize + (index < largerPodCount ? 1 : 0),
  )

  return sizes.every((size) => size === 3 || size === 4) ? sizes : null
}

function isSupportedPodSize(format: TournamentFormat, size: number) {
  return format === 'two-headed-giant'
    ? size === 2
    : size === 3 || size === 4
}

function getPodCapacity(format: TournamentFormat) {
  return format === 'two-headed-giant' ? 2 : 4
}

function getPairKey(firstPlayerId: string, secondPlayerId: string) {
  return JSON.stringify([firstPlayerId, secondPlayerId].sort())
}

function getPreviousPartners(rounds: TournamentRound[]) {
  const partners = new Set<string>()
  rounds.forEach((round) => {
    round.pods.forEach((pod) => {
      for (let first = 0; first < pod.playerIds.length; first += 1) {
        for (
          let second = first + 1;
          second < pod.playerIds.length;
          second += 1
        ) {
          const key = getPairKey(
            pod.playerIds[first],
            pod.playerIds[second],
          )
          partners.add(key)
        }
      }
    })
  })
  return partners
}

function getPodRepeatCount(
  playerIds: string[],
  previousPartners: Set<string>,
) {
  let repeats = 0
  for (let first = 0; first < playerIds.length; first += 1) {
    for (let second = first + 1; second < playerIds.length; second += 1) {
      if (previousPartners.has(getPairKey(playerIds[first], playerIds[second]))) {
        repeats += 1
      }
    }
  }
  return repeats
}

function getPodScoreSpread(
  playerIds: string[],
  pointsByPlayerId: Map<string, number>,
) {
  let spread = 0
  for (let first = 0; first < playerIds.length; first += 1) {
    for (let second = first + 1; second < playerIds.length; second += 1) {
      spread += Math.abs(
        (pointsByPlayerId.get(playerIds[first]) ?? 0) -
          (pointsByPlayerId.get(playerIds[second]) ?? 0),
      )
    }
  }
  return spread
}

function shufflePlayerIds(playerIds: string[]) {
  const shuffledPlayerIds = [...playerIds]
  for (let index = shuffledPlayerIds.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffledPlayerIds[index], shuffledPlayerIds[randomIndex]] = [
      shuffledPlayerIds[randomIndex],
      shuffledPlayerIds[index],
    ]
  }
  return shuffledPlayerIds
}

function generatePodGroups(
  playerIds: string[],
  podSizes: number[],
  pointsByPlayerId: Map<string, number>,
  previousPartners: Set<string>,
) {
  const orderedPlayerIds = [...playerIds].sort(
    (first, second) =>
      (pointsByPlayerId.get(second) ?? 0) -
      (pointsByPlayerId.get(first) ?? 0),
  )
  const pods: string[][] = []
  let nextPlayerIndex = 0

  podSizes.forEach((size) => {
    const pod: string[] = []
    while (pod.length < size) {
      let bestPlayerIndex = nextPlayerIndex
      let bestRepeats = Number.POSITIVE_INFINITY
      let bestSpread = Number.POSITIVE_INFINITY
      for (
        let candidateIndex = nextPlayerIndex;
        candidateIndex < orderedPlayerIds.length;
        candidateIndex += 1
      ) {
        const candidate = orderedPlayerIds[candidateIndex]
        const candidatePod = [...pod, candidate]
        const repeats = getPodRepeatCount(candidatePod, previousPartners)
        const spread = getPodScoreSpread(candidatePod, pointsByPlayerId)
        if (
          repeats < bestRepeats ||
          (repeats === bestRepeats && spread < bestSpread)
        ) {
          bestPlayerIndex = candidateIndex
          bestRepeats = repeats
          bestSpread = spread
        }
      }
      ;[orderedPlayerIds[nextPlayerIndex], orderedPlayerIds[bestPlayerIndex]] = [
        orderedPlayerIds[bestPlayerIndex],
        orderedPlayerIds[nextPlayerIndex],
      ]
      pod.push(orderedPlayerIds[nextPlayerIndex])
      nextPlayerIndex += 1
    }
    pods.push(pod)
  })

  let improved = true
  while (improved) {
    improved = false
    let bestSwap:
      | { firstPod: number; firstIndex: number; secondPod: number; secondIndex: number }
      | undefined
    let bestComparison = 0
    for (let firstPod = 0; firstPod < pods.length; firstPod += 1) {
      for (let secondPod = firstPod + 1; secondPod < pods.length; secondPod += 1) {
        for (
          let firstIndex = 0;
          firstIndex < pods[firstPod].length;
          firstIndex += 1
        ) {
          for (
            let secondIndex = 0;
            secondIndex < pods[secondPod].length;
            secondIndex += 1
          ) {
            const firstCandidate = [...pods[firstPod]]
            const secondCandidate = [...pods[secondPod]]
            ;[firstCandidate[firstIndex], secondCandidate[secondIndex]] = [
              secondCandidate[secondIndex],
              firstCandidate[firstIndex],
            ]
            const currentRepeats =
              getPodRepeatCount(pods[firstPod], previousPartners) +
              getPodRepeatCount(pods[secondPod], previousPartners)
            const candidateRepeats =
              getPodRepeatCount(firstCandidate, previousPartners) +
              getPodRepeatCount(secondCandidate, previousPartners)
            const currentSpread =
              getPodScoreSpread(pods[firstPod], pointsByPlayerId) +
              getPodScoreSpread(pods[secondPod], pointsByPlayerId)
            const candidateSpread =
              getPodScoreSpread(firstCandidate, pointsByPlayerId) +
              getPodScoreSpread(secondCandidate, pointsByPlayerId)
            const comparison =
              currentRepeats - candidateRepeats ||
              currentSpread - candidateSpread
            if (comparison > bestComparison) {
              bestComparison = comparison
              bestSwap = { firstPod, firstIndex, secondPod, secondIndex }
            }
          }
        }
      }
    }

    if (bestSwap) {
      const { firstPod, firstIndex, secondPod, secondIndex } = bestSwap
      ;[pods[firstPod][firstIndex], pods[secondPod][secondIndex]] = [
        pods[secondPod][secondIndex],
        pods[firstPod][firstIndex],
      ]
      improved = true
    }
  }

  return pods
}

function TournamentWorkspace({
  userId,
  initialTournaments,
  onSignOut,
  initialAutoSyncEnabled,
  adminMode = false,
  adminOwnerId,
  onAdminSave,
  onReturnToAdmin,
}: {
  userId: string
  initialTournaments: Tournament[]
  onSignOut: () => Promise<void>
  initialAutoSyncEnabled: boolean
  adminMode?: boolean
  adminOwnerId?: string
  onAdminSave?: (tournament: Tournament) => Promise<void>
  onReturnToAdmin?: () => void
}) {
  const [tournaments, setTournaments] =
    useState<Tournament[]>(initialTournaments)
  const [selectedTournamentId, setSelectedTournamentId] = useState<
    string | null
  >(() => tournaments[0]?.id ?? null)
  const [expandedRoundId, setExpandedRoundId] = useState<string | null>(() => {
    const firstTournament = initialTournaments[0]
    return (
      firstTournament?.rounds.find(
        ({ id }) => id === firstTournament.activeRoundId,
      )?.id ??
      firstTournament?.rounds[firstTournament.rounds.length - 1]?.id ??
      null
    )
  })
  const [tournamentName, setTournamentName] = useState('')
  const [tournamentFormat, setTournamentFormat] =
    useState<TournamentFormat>('commander')
  const [tournamentDate, setTournamentDate] = useState('')
  const [tournamentLocation, setTournamentLocation] = useState('')
  const [tournamentError, setTournamentError] = useState('')
  const [isEditingTournament, setIsEditingTournament] = useState(false)
  const [tournamentEditName, setTournamentEditName] = useState('')
  const [tournamentEditDate, setTournamentEditDate] = useState('')
  const [tournamentEditLocation, setTournamentEditLocation] = useState('')
  const [tournamentEditError, setTournamentEditError] = useState('')
  const [playerName, setPlayerName] = useState('')
  const [playerError, setPlayerError] = useState('')
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null)
  const [playerEditName, setPlayerEditName] = useState('')
  const [playerEditError, setPlayerEditError] = useState('')
  const [podSelections, setPodSelections] = useState<Record<string, string>>({})
  const [editingPodResults, setEditingPodResults] = useState<string[]>([])
  const [podResultDrafts, setPodResultDrafts] = useState<
    Record<string, Record<string, string>>
  >({})
  const [podResultErrors, setPodResultErrors] = useState<
    Record<string, string>
  >({})
  const [roundGenerationError, setRoundGenerationError] = useState('')
  const [tournamentStatusError, setTournamentStatusError] = useState('')
  const [tournamentStatusNotice, setTournamentStatusNotice] = useState('')
  const [backupNotice, setBackupNotice] = useState('')
  const [backupError, setBackupError] = useState('')
  const [tournamentDeleteError, setTournamentDeleteError] = useState('')
  const [isDeletingTournament, setIsDeletingTournament] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const [syncStatus, setSyncStatus] = useState<
    'pending' | 'syncing' | 'synced' | 'error'
  >('pending')
  const [syncError, setSyncError] = useState('')
  const [syncReview, setSyncReview] = useState<SyncReview | null>(null)
  const [lastSyncedSnapshot, setLastSyncedSnapshot] = useState<string | null>(
    null,
  )
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(
    initialAutoSyncEnabled,
  )
  const [autoSyncPreferenceSaving, setAutoSyncPreferenceSaving] =
    useState(false)
  const [autoSyncPreferenceError, setAutoSyncPreferenceError] = useState('')
  const [adminAccess, setAdminAccess] = useState(adminMode)
  const [adminAccessError, setAdminAccessError] = useState('')
  const [adminSaveError, setAdminSaveError] = useState('')
  const [adminSaving, setAdminSaving] = useState(false)
  const [adminEditingRecord, setAdminEditingRecord] =
    useState<TournamentRecord | null>(null)
  const [pendingProposalSummary, setPendingProposalSummary] = useState<{
    tournamentId: string
    roundId: string | null
    count: number | null
  } | null>(null)
  const reportPendingProposalCount = useCallback(
    (tournamentId: string, roundId: string | null, count: number | null) => {
      setPendingProposalSummary((current) =>
        current?.tournamentId === tournamentId &&
        current.roundId === roundId &&
        current.count === count
          ? current
          : { tournamentId, roundId, count },
      )
    },
    [],
  )
  const adminSaveLock = useRef(false)
  const tournamentDeletionInProgressRef = useRef(false)
  const pendingRoundScrollId = useRef<string | null>(null)
  const latestTournaments = useRef(tournaments)
  const autoSyncEnabledRef = useRef(initialAutoSyncEnabled)
  const syncInProgressRef = useRef(false)
  const autoSyncBootstrappedRef = useRef(false)
  const autoSyncNeedsRetryRef = useRef(false)
  const autoSyncQueuedRef = useRef(false)
  const suppressAutoSyncSnapshotRef = useRef<string | null>(null)
  const persistedSnapshotRef = useRef<string | null>(null)
  const previousTournamentSnapshotRef = useRef<string | null>(null)
  const retrySyncAfterReviewRef = useRef<boolean | null>(null)
  const beginSyncRef = useRef<(automatic?: boolean) => Promise<void>>(
    async () => {},
  )

  const selectedTournament =
    tournaments.find(({ id }) => id === selectedTournamentId) ?? null
  const tournamentIsClosed = Boolean(selectedTournament?.closedAt)
  const registrationClosed = Boolean(
    selectedTournament && selectedTournament.rounds.length > 0,
  )
  const participantLabel =
    selectedTournament?.format === 'two-headed-giant' ? 'pareja' : 'jugador'
  const participantsLabel =
    selectedTournament?.format === 'two-headed-giant' ? 'parejas' : 'jugadores'
  const localSnapshot = useMemo(() => canonicalJson(tournaments), [tournaments])
  const displayedSyncStatus =
    syncStatus === 'synced' && lastSyncedSnapshot !== localSnapshot
      ? 'pending'
      : syncStatus
  const standings = useMemo(
    () => (selectedTournament ? getTournamentStandings(selectedTournament) : []),
    [selectedTournament],
  )
  const controlRound = selectedTournament
    ? selectedTournament.rounds.find(
        ({ id }) => id === selectedTournament.activeRoundId,
      ) ?? selectedTournament.rounds[selectedTournament.rounds.length - 1] ?? null
    : null
  const controlRoundNumber =
    controlRound && selectedTournament
      ? selectedTournament.rounds.findIndex(
          ({ id }) => id === controlRound.id,
        ) + 1
      : 0
  const controlRoundAssignedPlayerIds = new Set(
    controlRound?.pods.flatMap((pod) => pod.playerIds) ?? [],
  )
  const controlRoundUnassignedCount = selectedTournament && controlRound
    ? selectedTournament.players.filter(
        (player) => !controlRoundAssignedPlayerIds.has(player.id),
      ).length
    : 0
  const controlRoundResultsCount =
    controlRound?.pods.filter((pod) => Boolean(pod.result)).length ?? 0
  const currentRoundPendingCount =
    pendingProposalSummary !== null &&
    selectedTournament !== null &&
    pendingProposalSummary.tournamentId === selectedTournament.id &&
    pendingProposalSummary.roundId === controlRound?.id
      ? pendingProposalSummary.count
      : null
  const nextRoundReadinessError =
    selectedTournament && selectedTournament.rounds.length > 0
      ? getPreviousRoundCompletionError(
          selectedTournament,
          selectedTournament.rounds.length,
        )
      : null

  useEffect(() => {
    const roundId = pendingRoundScrollId.current
    if (!roundId || roundId !== expandedRoundId) {
      return
    }
    const roundElement = document.getElementById(`round-${roundId}-section`)
    if (!roundElement) {
      return
    }

    pendingRoundScrollId.current = null
    roundElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [expandedRoundId, selectedTournament?.rounds.length, selectedTournamentId])

  useEffect(() => {
    if (!adminMode) {
      const saved = saveTournaments(userId, tournaments)
      persistedSnapshotRef.current = saved ? canonicalJson(tournaments) : null
    }
  }, [adminMode, tournaments, userId])

  useEffect(() => {
    latestTournaments.current = tournaments
  }, [tournaments])

  useEffect(() => {
    if (adminMode) {
      return
    }
    let active = true
    void hasTournamentAdminAccess(userId)
      .then((isAdmin) => {
        if (active) {
          setAdminAccess(isAdmin)
          setAdminAccessError('')
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setAdminAccess(false)
          setAdminAccessError(
            error instanceof Error
              ? error.message
              : 'No se pudo comprobar el acceso de administrador.',
          )
        }
      })
    return () => {
      active = false
    }
  }, [adminMode, userId])

  useEffect(() => {
    const previousSnapshot = previousTournamentSnapshotRef.current
    previousTournamentSnapshotRef.current = localSnapshot
    if (previousSnapshot === null || previousSnapshot === localSnapshot) {
      return
    }
    if (suppressAutoSyncSnapshotRef.current === localSnapshot) {
      suppressAutoSyncSnapshotRef.current = null
      return
    }
    if (
      adminMode ||
      !autoSyncEnabled ||
      !autoSyncEnabledRef.current ||
      syncReview !== null ||
      !autoSyncBootstrappedRef.current
    ) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      if (
        !autoSyncEnabledRef.current ||
        syncReview !== null ||
        tournamentDeletionInProgressRef.current ||
        isDeletingTournament
      ) {
        return
      }
      if (syncInProgressRef.current) {
        autoSyncQueuedRef.current = true
        return
      }
      if (
        persistedSnapshotRef.current !==
        canonicalJson(latestTournaments.current)
      ) {
        setSyncStatus('pending')
        setSyncError(
          'No se pudieron guardar los cambios localmente; no se enviaron a Supabase.',
        )
        return
      }
      if (!navigator.onLine) {
        autoSyncNeedsRetryRef.current = true
        setSyncStatus('pending')
        setSyncError(
          'Sin conexión. Los cambios se conservan localmente y se sincronizarán cuando vuelva la conexión.',
        )
        return
      }
      void beginSyncRef.current(true)
    }, 700)

    return () => window.clearTimeout(timeoutId)
  }, [
    adminMode,
    autoSyncEnabled,
    isDeletingTournament,
    localSnapshot,
    syncReview,
  ])

  useEffect(() => {
    if (adminMode) {
      return
    }

    function handleOffline() {
      if (!autoSyncEnabledRef.current) {
        return
      }
      autoSyncNeedsRetryRef.current = true
      setSyncStatus('pending')
      setSyncError(
        'Sin conexión. Los cambios se conservan localmente y se sincronizarán cuando vuelva la conexión.',
      )
    }

    function handleOnline() {
      if (
        autoSyncEnabledRef.current &&
        autoSyncNeedsRetryRef.current &&
        !tournamentDeletionInProgressRef.current &&
        !isDeletingTournament &&
        syncReview === null &&
        !syncInProgressRef.current
      ) {
        autoSyncNeedsRetryRef.current = false
        void beginSyncRef.current(true)
      }
    }

    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [adminMode, isDeletingTournament, syncReview])

  useEffect(() => {
    if (
      adminMode ||
      !autoSyncEnabled ||
      !autoSyncEnabledRef.current ||
      tournamentDeletionInProgressRef.current ||
      isDeletingTournament ||
      syncReview !== null ||
      !autoSyncQueuedRef.current
    ) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      if (
        !autoSyncEnabledRef.current ||
        tournamentDeletionInProgressRef.current ||
        isDeletingTournament ||
        syncInProgressRef.current ||
        syncReview !== null
      ) {
        return
      }
      autoSyncQueuedRef.current = false
      if (navigator.onLine) {
        void beginSyncRef.current(true)
      } else {
        autoSyncNeedsRetryRef.current = true
        setSyncStatus('pending')
      }
    }, 700)
    return () => window.clearTimeout(timeoutId)
  }, [
    adminMode,
    autoSyncEnabled,
    isDeletingTournament,
    syncReview,
    syncStatus,
  ])

  function chooseConflict(id: string, choice: 'local' | 'remote') {
    if (!syncReview || syncInProgressRef.current) {
      return
    }

    const updatedReview = {
      ...syncReview,
      conflicts: syncReview.conflicts.map((conflict) =>
        conflict.id === id ? { ...conflict, choice } : conflict,
      ),
    }
    if (updatedReview.conflicts.some((conflict) => conflict.choice === null)) {
      setSyncReview(updatedReview)
      return
    }

    syncInProgressRef.current = true
    setSyncReview(null)
    void commitSync(updatedReview, updatedReview.automatic)
  }

  async function commitSync(review: SyncReview, automatic: boolean) {
    const combined = combineTournaments(review)
    if (!combined) {
      setSyncError('Resuelve todos los conflictos antes de continuar.')
      syncInProgressRef.current = false
      setSyncStatus('pending')
      return
    }

    setSyncStatus('syncing')
    setSyncError('')
    try {
      const latestLocal = readTournamentsForSync(userId)
      if (!sameTournamentList(latestLocal, review.localTournaments)) {
        throw new Error(
          'Los torneos locales cambiaron durante la revisión. Vuelve a iniciar la sincronización.',
        )
      }

      const latestRemote = await fetchTournaments(userId)
      if (!sameRemoteRecords(latestRemote, review.remoteRecords)) {
        const refreshedReview = createSyncReview(
          latestLocal,
          latestRemote,
          automatic,
        )
        if (refreshedReview.conflicts.length > 0) {
          setSyncReview(refreshedReview)
          setSyncStatus('pending')
          setSyncError(
            'Supabase cambió durante la revisión. Elige de nuevo qué versión conservar; no se han sobrescrito datos.',
          )
        } else {
          setSyncReview(null)
          setSyncStatus('pending')
          setSyncError(
            'Supabase cambió durante la revisión. Se comprobará la versión actualizada antes de sincronizar.',
          )
          retrySyncAfterReviewRef.current = automatic
        }
        return
      }

      const localBeforeWrite = readTournamentsForSync(userId)
      if (
        !sameTournamentList(localBeforeWrite, review.localTournaments) ||
        !sameTournamentList(latestTournaments.current, review.localTournaments)
      ) {
        throw new Error(
          'Los torneos locales cambiaron durante la revisión. Tus cambios se conservaron; vuelve a sincronizar.',
        )
      }

      const remoteIds = new Set(
        review.remoteRecords.map(({ tournament }) => tournament.id),
      )
      const localConflictIds = new Set(
        review.conflicts
          .filter(({ choice }) => choice === 'local')
          .map(({ id }) => id),
      )
      const tournamentsToUpload = automatic
        ? combined.filter(
            ({ id }) => !remoteIds.has(id) || localConflictIds.has(id),
          )
        : combined

      if (automatic && !autoSyncEnabledRef.current) {
        setSyncReview(null)
        setSyncStatus('pending')
        return
      }
      if (tournamentsToUpload.length > 0) {
        await saveTournamentsToSupabase(userId, tournamentsToUpload)
      }

      const localAfterUpload = readTournamentsForSync(userId)
      if (
        !sameTournamentList(localAfterUpload, review.localTournaments) ||
        !sameTournamentList(
          latestTournaments.current,
          review.localTournaments,
        )
      ) {
        throw new Error(
          'Los torneos locales cambiaron durante la sincronización. Tus cambios se conservaron y siguen pendientes.',
        )
      }

      if (!saveTournaments(userId, combined)) {
        throw new Error(
          'No se pudo guardar localmente la lista sincronizada. Tus datos locales anteriores se conservaron.',
        )
      }

      const combinedSnapshot = canonicalJson(combined)
      persistedSnapshotRef.current = combinedSnapshot
      suppressAutoSyncSnapshotRef.current =
        combinedSnapshot === canonicalJson(latestTournaments.current)
          ? null
          : combinedSnapshot
      setTournaments(combined)
      setLastSyncedSnapshot(canonicalJson(combined))
      setSyncReview(null)
      setSyncStatus('synced')
      autoSyncNeedsRetryRef.current = false
    } catch (error) {
      setSyncError(getSyncErrorMessage(error))
      setSyncStatus(automatic ? 'pending' : 'error')
      if (automatic) {
        autoSyncNeedsRetryRef.current = true
        if (review.conflicts.length === 0) {
          setSyncReview(null)
        }
      }
    } finally {
      syncInProgressRef.current = false
      const retryAutomatically = retrySyncAfterReviewRef.current
      retrySyncAfterReviewRef.current = null
      if (retryAutomatically !== null) {
        window.setTimeout(
          () => void beginSyncRef.current(retryAutomatically),
          0,
        )
      }
    }
  }

  async function beginSync(automatic = false) {
    if (
      syncInProgressRef.current ||
      tournamentDeletionInProgressRef.current ||
      isDeletingTournament ||
      (automatic && (!autoSyncEnabledRef.current || syncReview !== null))
    ) {
      return
    }

    syncInProgressRef.current = true
    setSyncStatus('syncing')
    setSyncError('')
    if (!automatic) {
      setSyncReview(null)
    }
    try {
      const localTournaments = readTournamentsForSync(userId)
      if (!sameTournamentList(localTournaments, latestTournaments.current)) {
        throw new Error(
          'Los torneos locales cambiaron. Espera a que se guarden y vuelve a sincronizar.',
        )
      }

      const remoteRecords = await fetchTournaments(userId)
      const review = createSyncReview(
        localTournaments,
        remoteRecords,
        automatic,
      )
      if (review.conflicts.length > 0) {
        setSyncReview(review)
        setSyncStatus('pending')
        syncInProgressRef.current = false
        return
      }

      setSyncReview(null)
      await commitSync(review, automatic)
    } catch (error) {
      setSyncError(getSyncErrorMessage(error))
      setSyncStatus(automatic ? 'pending' : 'error')
      if (automatic) {
        autoSyncNeedsRetryRef.current = true
      }
      syncInProgressRef.current = false
    }
  }

  useEffect(() => {
    beginSyncRef.current = beginSync
  })

  useEffect(() => {
    if (adminMode || !autoSyncEnabled) {
      return
    }

    autoSyncEnabledRef.current = true
    if (autoSyncBootstrappedRef.current) {
      return
    }
    autoSyncBootstrappedRef.current = true
    if (!navigator.onLine) {
      autoSyncNeedsRetryRef.current = true
      const timeoutId = window.setTimeout(() => {
        setSyncStatus('pending')
        setSyncError(
          'Sin conexión. Los cambios se conservan localmente y se sincronizarán cuando vuelva la conexión.',
        )
      }, 0)
      return () => window.clearTimeout(timeoutId)
    }
    void beginSyncRef.current(true)
  }, [adminMode, autoSyncEnabled, userId])

  function cancelSyncReview() {
    if (syncInProgressRef.current) {
      return
    }
    setSyncReview(null)
    setSyncError('')
    setSyncStatus(
      lastSyncedSnapshot === localSnapshot ? 'synced' : 'pending',
    )
  }

  async function changeAutomaticSync(enabled: boolean) {
    if (autoSyncPreferenceSaving || adminMode) {
      return
    }

    const previousValue = autoSyncEnabledRef.current
    const previousBootstrapped = autoSyncBootstrappedRef.current
    if (!enabled) {
      autoSyncEnabledRef.current = false
      autoSyncBootstrappedRef.current = false
    }
    setAutoSyncPreferenceSaving(true)
    setAutoSyncPreferenceError('')
    try {
      await updateAutomaticSyncPreference(enabled)
      autoSyncEnabledRef.current = enabled
      setAutoSyncEnabled(enabled)
      if (enabled) {
        autoSyncBootstrappedRef.current = false
        autoSyncNeedsRetryRef.current = false
        setSyncStatus('pending')
      }
    } catch (error) {
      autoSyncEnabledRef.current = previousValue
      autoSyncBootstrappedRef.current = previousBootstrapped
      setAutoSyncPreferenceError(
        error instanceof Error
          ? error.message
          : 'No se pudo actualizar la preferencia de sincronización automática.',
      )
    } finally {
      setAutoSyncPreferenceSaving(false)
    }
  }

  async function updateSelectedTournament(
    update: (tournament: Tournament) => Tournament,
  ): Promise<boolean> {
    if (!selectedTournament) {
      return false
    }
    if (adminSaveLock.current) {
      setAdminSaveError('Espera a que termine el guardado actual.')
      return false
    }

    const updatedTournament = update(selectedTournament)
    if (!adminMode) {
      setTournaments((current) =>
        current.map((tournament) =>
          tournament.id === selectedTournament.id
            ? updatedTournament
            : tournament,
        ),
      )
      return true
    }

    if (!adminOwnerId || !onAdminSave) {
      setAdminSaveError('No se pudo guardar el torneo administrado.')
      return false
    }
    adminSaveLock.current = true
    setAdminSaving(true)
    setAdminSaveError('')
    try {
      await onAdminSave(updatedTournament)
      setTournaments([updatedTournament])
      return true
    } catch (error: unknown) {
      setAdminSaveError(
          error instanceof Error
            ? error.message
            : 'No se pudieron guardar los cambios del torneo.',
      )
      return false
    } finally {
      adminSaveLock.current = false
      setAdminSaving(false)
    }
  }

  async function deleteSelectedTournament() {
    if (
      !selectedTournament ||
      adminMode ||
      isDeletingTournament ||
      syncInProgressRef.current ||
      tournamentDeletionInProgressRef.current ||
      syncReview !== null
    ) {
      return
    }

    const tournamentToDelete = selectedTournament
    const confirmed = window.confirm(
      `¿Eliminar «${tournamentToDelete.name}»? Se borrarán también sus participantes, rondas, resultados y enlace público. Esta acción no se puede deshacer.`,
    )
    if (!confirmed) {
      return
    }

    tournamentDeletionInProgressRef.current = true
    setIsDeletingTournament(true)
    setTournamentDeleteError('')
    try {
      await deleteTournamentFromSupabase(userId, tournamentToDelete.id)
      const remainingTournaments = tournaments.filter(
        ({ id }) => id !== tournamentToDelete.id,
      )
      const nextTournament = remainingTournaments[0] ?? null
      setTournaments(remainingTournaments)
      setSelectedTournamentId(nextTournament?.id ?? null)
      setExpandedRoundId(
        nextTournament?.rounds.find(
          ({ id }) => id === nextTournament.activeRoundId,
        )?.id ??
          nextTournament?.rounds[nextTournament.rounds.length - 1]?.id ??
          null,
      )
      setIsEditingTournament(false)
      setBackupNotice('')
      setBackupError('')
    } catch (error: unknown) {
      setTournamentDeleteError(
        error instanceof Error
          ? error.message
          : 'No se pudo eliminar el torneo. Inténtalo de nuevo.',
      )
    } finally {
      tournamentDeletionInProgressRef.current = false
      setIsDeletingTournament(false)
    }
  }

  function startEditingTournament() {
    if (!selectedTournament || selectedTournament.closedAt) {
      return
    }
    setTournamentEditName(selectedTournament.name)
    setTournamentEditDate(selectedTournament.date)
    setTournamentEditLocation(selectedTournament.location)
    setTournamentEditError('')
    setIsEditingTournament(true)
  }

  function cancelTournamentEdit() {
    setIsEditingTournament(false)
    setTournamentEditError('')
  }

  async function saveTournamentDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedTournament || selectedTournament.closedAt) {
      return
    }
    const name = tournamentEditName.trim()
    if (!name) {
      setTournamentEditError('El nombre del torneo es obligatorio.')
      return
    }

    const saved = await updateSelectedTournament((tournament) => ({
      ...tournament,
      name,
      date: tournamentEditDate,
      location: tournamentEditLocation.trim(),
    }))
    if (saved) {
      setIsEditingTournament(false)
      setTournamentEditError('')
    }
  }

  function startEditingPlayer(playerId: string, name: string) {
    if (selectedTournament?.closedAt) {
      return
    }
    setEditingPlayerId(playerId)
    setPlayerEditName(name)
    setPlayerEditError('')
  }

  async function savePlayerName(
    event: FormEvent<HTMLFormElement>,
    playerId: string,
  ) {
    event.preventDefault()
    const name = playerEditName.trim()
    if (!selectedTournament || selectedTournament.closedAt || !name) {
      setPlayerEditError('El nombre del participante es obligatorio.')
      return
    }
    const duplicate = selectedTournament.players.some(
      (player) =>
        player.id !== playerId &&
        player.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
    if (duplicate) {
      setPlayerEditError('Ya existe un participante con ese nombre.')
      return
    }

    const saved = await updateSelectedTournament((tournament) => ({
      ...tournament,
      players: tournament.players.map((player) =>
        player.id === playerId ? { ...player, name } : player,
      ),
    }))
    if (saved) {
      setEditingPlayerId(null)
      setPlayerEditError('')
    }
  }

  function createTournament(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = tournamentName.trim()

    if (!name) {
      setTournamentError('Escribe un nombre para el torneo.')
      return
    }

    const tournament: Tournament = {
      id: crypto.randomUUID(),
      name,
      format: tournamentFormat,
      date: tournamentDate,
      location: tournamentLocation.trim(),
      players: [],
      rounds: [],
    }

    if (adminMode) {
      setTournaments([tournament])
    } else {
      setTournaments((current) => [...current, tournament])
    }
    pendingRoundScrollId.current = null
    setExpandedRoundId(null)
    setSelectedTournamentId(tournament.id)
    setTournamentName('')
    setTournamentFormat('commander')
    setTournamentDate('')
    setTournamentLocation('')
    setTournamentError('')
  }

  function addPlayer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = playerName.trim()

    if (!selectedTournament) {
      return
    }

    if (selectedTournament.rounds.length > 0) {
      setPlayerError(
        'La inscripción se cerró al iniciar la primera ronda. No se pueden añadir más participantes.',
      )
      return
    }

    if (selectedTournament.closedAt || !name) {
      setPlayerError(`Escribe el nombre de la ${participantLabel}.`)
      return
    }

    const alreadyAdded = selectedTournament.players.some(
      (player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )

    if (alreadyAdded) {
      setPlayerError(
        selectedTournament.format === 'two-headed-giant'
          ? 'Esa pareja ya está en la lista.'
          : 'Ese jugador ya está en la lista.',
      )
      return
    }

    updateSelectedTournament((tournament) => ({
      ...tournament,
      players: [...tournament.players, { id: crypto.randomUUID(), name }],
    }))
    setPlayerName('')
    setPlayerError('')
  }

  function removePlayer(playerId: string) {
    if (!selectedTournament || selectedTournament.closedAt) {
      return
    }

    updateSelectedTournament((tournament) => ({
      ...tournament,
      players: tournament.players.filter((player) => player.id !== playerId),
      rounds: tournament.rounds.map((round) => ({
        ...round,
        pods: round.pods.map((pod) => ({
          ...pod,
          playerIds: pod.playerIds.filter((id) => id !== playerId),
          ...(pod.playerIds.includes(playerId) ? { result: undefined } : {}),
        })),
      })),
    }))
  }

  function getRoundCompletionError(
    tournament: Tournament,
    roundIndex: number,
  ): string | null {
    const tournamentPlayerIds = new Set(
      tournament.players.map((player) => player.id),
    )
    const round = tournament.rounds[roundIndex]
    if (!round) {
      return `No se puede avanzar: la ronda ${roundIndex + 1} no existe.`
    }
    const roundNumber = roundIndex + 1
    if (round.pods.length === 0) {
      return `No se puede avanzar: la ronda ${roundNumber} no tiene mesas. Completa sus mesas y resultados antes de continuar.`
    }

    const assignedPlayerIds = new Set<string>()
    for (let podIndex = 0; podIndex < round.pods.length; podIndex += 1) {
      const pod = round.pods[podIndex]
      const tableNumber = podIndex + 1
      if (!isSupportedPodSize(tournament.format, pod.playerIds.length)) {
        return tournament.format === 'two-headed-giant'
          ? `No se puede avanzar: ronda ${roundNumber}, mesa ${tableNumber} debe tener exactamente 2 parejas.`
          : `No se puede avanzar: ronda ${roundNumber}, mesa ${tableNumber} tiene ${pod.playerIds.length} jugadores; debe tener 3 o 4.`
      }
      if (new Set(pod.playerIds).size !== pod.playerIds.length) {
        return `No se puede avanzar: ronda ${roundNumber}, mesa ${tableNumber} tiene participantes duplicados.`
      }

      for (const playerId of pod.playerIds) {
        if (!tournamentPlayerIds.has(playerId)) {
          return `No se puede avanzar: ronda ${roundNumber}, mesa ${tableNumber} incluye un jugador que ya no está en el torneo.`
        }
        if (assignedPlayerIds.has(playerId)) {
          const playerName =
            tournament.players.find((player) => player.id === playerId)
              ?.name ?? playerId
          return `No se puede avanzar: ronda ${roundNumber}, mesa ${tableNumber} vuelve a asignar a ${playerName}, que ya está en otra mesa.`
        }
        assignedPlayerIds.add(playerId)
      }
    }

    const unassignedPlayers = tournament.players.filter(
      (player) => !assignedPlayerIds.has(player.id),
    )
    if (unassignedPlayers.length > 0) {
      return `No se puede avanzar: en la ronda ${roundNumber} faltan ${tournament.format === 'two-headed-giant' ? 'parejas' : 'jugadores'} por asignar: ${unassignedPlayers.map((player) => player.name).join(', ')}.`
    }

    for (let podIndex = 0; podIndex < round.pods.length; podIndex += 1) {
      const pod = round.pods[podIndex]
      if (!pod.result) {
        return `No se puede avanzar: ronda ${roundNumber}, mesa ${podIndex + 1} aún no tiene un resultado oficial aprobado.`
      }

      const resultPlayerIds = pod.result.placements.flat()
      if (
        resultPlayerIds.length !== pod.playerIds.length ||
        new Set(resultPlayerIds).size !== resultPlayerIds.length ||
        resultPlayerIds.some((playerId) => !pod.playerIds.includes(playerId))
      ) {
        return `No se puede avanzar: ronda ${roundNumber}, mesa ${podIndex + 1} tiene un resultado oficial incompleto. Corrígelo antes de continuar.`
      }
    }

    return null
  }

  function getPreviousRoundCompletionError(
    tournament: Tournament,
    targetRoundIndex: number,
  ): string | null {
    for (let roundIndex = 0; roundIndex < targetRoundIndex; roundIndex += 1) {
      const error = getRoundCompletionError(tournament, roundIndex)
      if (error) {
        return error
      }
    }
    return null
  }

  async function closeSelectedTournament() {
    if (!selectedTournament || selectedTournament.closedAt) {
      return
    }
    setTournamentStatusError('')
    setTournamentStatusNotice('')

    if (editingPlayerId || editingPodResults.length > 0) {
      setTournamentStatusError(
        'Guarda o cancela las ediciones abiertas antes de cerrar el torneo.',
      )
      return
    }

    if (selectedTournament.rounds.length === 0) {
      setTournamentStatusError(
        'Crea y completa al menos una ronda antes de cerrar el torneo.',
      )
      return
    }

    const completionError = getPreviousRoundCompletionError(
      selectedTournament,
      selectedTournament.rounds.length,
    )
    if (completionError) {
      setTournamentStatusError(
        completionError.replace('No se puede avanzar:', 'No se puede cerrar:'),
      )
      return
    }

    if (
      !window.confirm(
        'Al cerrar el torneo, el QR mostrará la clasificación final y dejará de aceptar resultados. ¿Quieres continuar?',
      )
    ) {
      return
    }

    const saved = await updateSelectedTournament((tournament) => ({
      ...tournament,
      closedAt: new Date().toISOString(),
    }))
    if (saved) {
      setTournamentStatusNotice(
        adminMode
          ? 'Torneo cerrado. El QR mostrará la clasificación final.'
          : autoSyncEnabled
            ? 'Torneo cerrado. El QR mostrará la clasificación cuando termine la sincronización.'
            : 'Torneo cerrado en este dispositivo. Sincroniza los cambios para actualizar el QR.',
      )
    }
  }

  async function reopenSelectedTournament() {
    if (!selectedTournament?.closedAt) {
      return
    }
    setTournamentStatusError('')
    setTournamentStatusNotice('')
    if (
      !window.confirm(
        'Al reabrir el torneo, el QR volverá a mostrar la ronda activa y el organizador podrá seguir editándolo. ¿Quieres continuar?',
      )
    ) {
      return
    }

    const saved = await updateSelectedTournament((tournament) => ({
      ...tournament,
      closedAt: undefined,
    }))
    if (saved) {
      setTournamentStatusNotice(
        adminMode
          ? 'Torneo reabierto.'
          : autoSyncEnabled
            ? 'Torneo reabierto. El QR se actualizará al terminar la sincronización.'
            : 'Torneo reabierto en este dispositivo. Sincroniza los cambios para actualizar el QR.',
      )
    }
  }

  function createSelectedTournamentBackup() {
    if (!selectedTournament) {
      return
    }
    setBackupNotice('')
    setBackupError('')
    try {
      downloadTournamentBackup(selectedTournament)
      setBackupNotice('Copia de seguridad descargada.')
    } catch {
      setBackupError('No se pudo descargar la copia de seguridad.')
    }
  }

  async function createRound() {
    if (!selectedTournament || selectedTournament.closedAt) {
      return
    }
    const previousRoundError = getPreviousRoundCompletionError(
      selectedTournament,
      selectedTournament.rounds.length,
    )
    if (previousRoundError) {
      setRoundGenerationError(previousRoundError)
      return
    }

    const roundId = crypto.randomUUID()
    const previousExpandedRoundId = expandedRoundId
    pendingRoundScrollId.current = roundId
    setExpandedRoundId(roundId)
    const saved = await updateSelectedTournament((tournament) => ({
      ...tournament,
      activeRoundId: roundId,
      rounds: [...tournament.rounds, { id: roundId, pods: [] }],
    }))
    if (saved) {
      setRoundGenerationError('')
    } else {
      pendingRoundScrollId.current = null
      setExpandedRoundId(previousExpandedRoundId)
    }
  }

  async function generateRoundAutomatically(roundId: string | null) {
    if (!selectedTournament || selectedTournament.closedAt) {
      return
    }

    const roundIndex =
      roundId === null
        ? selectedTournament.rounds.length
        : selectedTournament.rounds.findIndex((round) => round.id === roundId)
    const existingRound =
      roundId === null
        ? undefined
        : selectedTournament.rounds.find((round) => round.id === roundId)
    if (roundIndex < 0 || (roundId !== null && !existingRound)) {
      return
    }

    if (roundId !== null && roundIndex < selectedTournament.rounds.length - 1) {
      setRoundGenerationError(
        'No se pueden regenerar las mesas de una ronda anterior cuando ya existe una ronda posterior.',
      )
      return
    }
    if (existingRound?.pods.some((pod) => pod.result)) {
      setRoundGenerationError(
        'No se pueden regenerar las mesas de una ronda que ya tiene resultados oficiales.',
      )
      return
    }

    const previousRoundError = getPreviousRoundCompletionError(
      selectedTournament,
      roundIndex,
    )
    if (previousRoundError) {
      setRoundGenerationError(previousRoundError)
      return
    }

    if (roundId !== null) {
      const hasPendingProposal = await hasPendingResultProposal(roundId)
      if (hasPendingProposal === null) {
        return
      }
      if (hasPendingProposal) {
        setRoundGenerationError(
          'No se pueden regenerar las mesas mientras haya propuestas de resultado pendientes para esta ronda.',
        )
        return
      }
    }

    const podSizes = getBalancedPodSizes(
      selectedTournament.players.length,
      selectedTournament.format,
    )
    if (!podSizes) {
      setRoundGenerationError(
        selectedTournament.format === 'two-headed-giant'
          ? `Para Dos Cabezas necesitas un número par de parejas (al menos 2); cada mesa enfrenta exactamente 2 parejas. Ahora hay ${selectedTournament.players.length}.`
          : `No existe una distribución válida para ${selectedTournament.players.length} jugadores: las mesas deben tener 3 o 4 jugadores y no puede quedar nadie fuera.`,
      )
      return
    }

    if (
      existingRound &&
      existingRound.pods.length > 0 &&
      !window.confirm(
        'Esta ronda ya tiene mesas o asignaciones. Si continúas, se reemplazarán. ¿Quieres generar las mesas automáticamente?',
      )
    ) {
      return
    }

    const previousRounds = selectedTournament.rounds.slice(0, roundIndex)
    const pointsByPlayerId = new Map(
      selectedTournament.players.map((player) => [player.id, 0]),
    )
    previousRounds.forEach((round) => {
      round.pods.forEach((pod) => {
        if (!pod.result) {
          return
        }
        getPodPoints(
          pod.result,
          pod.playerIds.length,
          selectedTournament.format,
        ).forEach(
          (points, playerId) => {
            pointsByPlayerId.set(
              playerId,
              (pointsByPlayerId.get(playerId) ?? 0) + points,
            )
          },
        )
      })
    })

    const playerIds = selectedTournament.players.map(({ id }) => id)
    const orderedPlayerIds =
      roundIndex === 0 ? shufflePlayerIds(playerIds) : playerIds

    const groups = generatePodGroups(
      orderedPlayerIds,
      podSizes,
      pointsByPlayerId,
      getPreviousPartners(previousRounds),
    )
    const pods = groups.map((group) => ({
      id: crypto.randomUUID(),
      playerIds: group,
    }))
    const generatedRoundId = roundId ?? crypto.randomUUID()
    const startedAt = new Date().toISOString()
    const previousExpandedRoundId = expandedRoundId
    if (roundId === null) {
      pendingRoundScrollId.current = generatedRoundId
      setExpandedRoundId(generatedRoundId)
    }

    const saved = await updateSelectedTournament((tournament) => ({
      ...tournament,
      ...(roundId === null ? { activeRoundId: generatedRoundId } : {}),
      rounds:
        roundId === null
          ? [...tournament.rounds, { id: generatedRoundId, startedAt, pods }]
          : tournament.rounds.map((round) =>
              round.id === generatedRoundId
                ? { ...round, startedAt, pods }
                : round,
            ),
    }))
    if (saved) {
      setExpandedRoundId(generatedRoundId)
      setRoundGenerationError('')
    } else if (roundId === null) {
      pendingRoundScrollId.current = null
      setExpandedRoundId(previousExpandedRoundId)
    }
  }

  function addPod(roundId: string) {
    if (!selectedTournament || selectedTournament.closedAt) {
      return
    }
    const roundIndex = selectedTournament.rounds.findIndex(
      (round) => round.id === roundId,
    )
    if (roundIndex < 0) {
      return
    }
    if (getRoundCompletionError(selectedTournament, roundIndex) === null) {
      setRoundGenerationError(
        'No se pueden añadir mesas a una ronda que ya está completa.',
      )
      return
    }
    updateSelectedTournament((tournament) => ({
      ...tournament,
      rounds: tournament.rounds.map((round) =>
        round.id === roundId
          ? {
              ...round,
              pods: [...round.pods, { id: crypto.randomUUID(), playerIds: [] }],
            }
          : round,
      ),
    }))
  }

  async function hasPendingResultProposal(
    roundId: string,
    podId?: string,
  ): Promise<boolean | null> {
    if (!adminMode && !adminAccess) {
      return false
    }

    if (!selectedTournament) {
      return null
    }

    try {
      const proposals = await fetchTournamentResultProposals(
        selectedTournament.id,
      )
      return proposals.some(
        (proposal) =>
          proposal.roundId === roundId &&
          (podId === undefined || proposal.podId === podId),
      )
    } catch {
      setRoundGenerationError(
        'No se pudo comprobar si hay resultados pendientes. Inténtalo de nuevo.',
      )
      return null
    }
  }

  async function deletePod(
    roundId: string,
    podId: string,
    podNumber: number,
    roundNumber: number,
  ) {
    if (!selectedTournament || selectedTournament.closedAt || adminSaving) {
      return
    }

    const round = selectedTournament.rounds.find(({ id }) => id === roundId)
    const pod = round?.pods.find(({ id }) => id === podId)
    if (!round || !pod || round.startedAt || pod.result) {
      setRoundGenerationError(
        'Solo puedes eliminar mesas de una ronda que aún no se ha lanzado y no tiene resultados.',
      )
      return
    }

    const hasPendingProposal = await hasPendingResultProposal(roundId, podId)
    if (hasPendingProposal === null) {
      return
    }
    if (hasPendingProposal) {
      setRoundGenerationError(
        'No se puede eliminar esta mesa porque ya tiene una propuesta de resultado enviada desde el QR.',
      )
      return
    }

    const confirmed = window.confirm(
      `¿Eliminar la mesa ${podNumber} de la ronda ${roundNumber}? Los participantes asignados quedarán sin asignar.`,
    )
    if (!confirmed) {
      return
    }

    const saved = await updateSelectedTournament((tournament) => ({
      ...tournament,
      rounds: tournament.rounds.map((currentRound) =>
        currentRound.id === roundId
          ? {
              ...currentRound,
              pods: currentRound.pods.filter(({ id }) => id !== podId),
            }
          : currentRound,
      ),
    }))
    if (!saved) {
      return
    }

    setPodSelections((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([currentPodId]) => currentPodId !== podId),
      ),
    )
    setPodResultDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([currentPodId]) => currentPodId !== podId),
      ),
    )
    setPodResultErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([currentPodId]) => currentPodId !== podId),
      ),
    )
    setEditingPodResults((current) =>
      current.filter((currentPodId) => currentPodId !== podId),
    )
    setRoundGenerationError('')
  }

  async function deleteRound(roundId: string, roundNumber: number) {
    if (!selectedTournament || selectedTournament.closedAt || adminSaving) {
      return
    }

    const round = selectedTournament.rounds.find(({ id }) => id === roundId)
    if (!round) {
      return
    }
    if (round.pods.some((pod) => pod.result)) {
      setRoundGenerationError(
        'No se puede eliminar una ronda que ya tiene resultados oficiales.',
      )
      return
    }

    const hasPendingProposal = await hasPendingResultProposal(roundId)
    if (hasPendingProposal === null) {
      return
    }
    if (hasPendingProposal) {
      setRoundGenerationError(
        'No se puede eliminar esta ronda porque ya hay una propuesta de resultado enviada desde el QR.',
      )
      return
    }

    const confirmed = window.confirm(
      `¿Eliminar la ronda ${roundNumber}? Solo se puede borrar si todavía no tiene resultados. Esta acción no se puede deshacer.`,
    )
    if (!confirmed) {
      return
    }

    const remainingRounds = selectedTournament.rounds.filter(
      ({ id }) => id !== roundId,
    )
    const nextActiveRoundId =
      selectedTournament.activeRoundId === roundId
        ? remainingRounds[remainingRounds.length - 1]?.id
        : selectedTournament.activeRoundId
    const removedPodIds = new Set(round.pods.map(({ id }) => id))
    const saved = await updateSelectedTournament((tournament) => {
      const { activeRoundId, ...tournamentWithoutActiveRound } = tournament
      const nextRoundId =
        activeRoundId === roundId
          ? remainingRounds[remainingRounds.length - 1]?.id
          : activeRoundId
      return {
        ...tournamentWithoutActiveRound,
        rounds: tournament.rounds.filter(({ id }) => id !== roundId),
        ...(nextRoundId ? { activeRoundId: nextRoundId } : {}),
      }
    })
    if (!saved) {
      return
    }

    if (expandedRoundId === roundId) {
      setExpandedRoundId(nextActiveRoundId ?? null)
    }
    if (pendingRoundScrollId.current === roundId) {
      pendingRoundScrollId.current = null
    }
    setPodSelections((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([podId]) => !removedPodIds.has(podId)),
      ),
    )
    setPodResultDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([podId]) => !removedPodIds.has(podId)),
      ),
    )
    setPodResultErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([podId]) => !removedPodIds.has(podId)),
      ),
    )
    setEditingPodResults((current) =>
      current.filter((podId) => !removedPodIds.has(podId)),
    )
    setRoundGenerationError('')
  }

  function assignPlayer(roundId: string, podId: string) {
    const playerId = podSelections[podId]
    if (!selectedTournament || selectedTournament.closedAt || !playerId) {
      return
    }

    const round = selectedTournament.rounds.find(({ id }) => id === roundId)
    const pod = round?.pods.find(({ id }) => id === podId)
    const alreadyAssigned = round?.pods.some(({ playerIds }) =>
      playerIds.includes(playerId),
    )

    if (
      !pod ||
      pod.playerIds.length >= getPodCapacity(selectedTournament.format) ||
      alreadyAssigned ||
      !selectedTournament.players.some(({ id }) => id === playerId)
    ) {
      return
    }

    const startedAt = new Date().toISOString()
    updateSelectedTournament((tournament) => ({
      ...tournament,
      rounds: tournament.rounds.map((currentRound) => {
        if (currentRound.id !== roundId) {
          return currentRound
        }

        const pods = currentRound.pods.map((currentPod) =>
          currentPod.id === podId
            ? {
                ...currentPod,
                playerIds: [...currentPod.playerIds, playerId],
                result: undefined,
              }
            : currentPod,
        )
        const allPlayersAssigned = tournament.players.every((player) =>
          pods.some((currentPod) =>
            currentPod.playerIds.includes(player.id),
          ),
        )

        return {
          ...currentRound,
          ...(!currentRound.startedAt && allPlayersAssigned
            ? { startedAt }
            : {}),
          pods,
        }
      }),
    }))
    setPodSelections((current) =>
      Object.fromEntries(
        Object.entries(current).map(([currentPodId, selectedPlayerId]) => [
          currentPodId,
          selectedPlayerId === playerId ? '' : selectedPlayerId,
        ]),
      ),
    )
  }

  function unassignPlayer(roundId: string, podId: string, playerId: string) {
    if (selectedTournament?.closedAt) {
      return
    }
    updateSelectedTournament((tournament) => ({
      ...tournament,
      rounds: tournament.rounds.map((round) =>
        round.id === roundId
          ? {
              ...round,
              pods: round.pods.map((pod) =>
                pod.id === podId
                  ? {
                      ...pod,
                      playerIds: pod.playerIds.filter((id) => id !== playerId),
                      result: undefined,
                    }
                  : pod,
              ),
            }
          : round,
      ),
    }))
  }

  function startEditingPodResult(pod: Pod) {
    if (selectedTournament?.closedAt) {
      return
    }
    const ranksByPlayerId = new Map<string, string>()
    if (selectedTournament?.format === 'two-headed-giant') {
      if (pod.result?.placements.length === 1) {
        pod.result.placements[0].forEach((teamId) =>
          ranksByPlayerId.set(teamId, 'draw'),
        )
      } else {
        pod.result?.placements[0]?.forEach((teamId) =>
          ranksByPlayerId.set(teamId, 'win'),
        )
        pod.result?.placements[1]?.forEach((teamId) =>
          ranksByPlayerId.set(teamId, 'loss'),
        )
      }
    } else {
      let place = 1
      pod.result?.placements.forEach((placement) => {
        placement.forEach((playerId) =>
          ranksByPlayerId.set(playerId, String(place)),
        )
        place += placement.length
      })
    }

    setPodResultDrafts((current) => ({
      ...current,
      [pod.id]: Object.fromEntries(
        pod.playerIds.map((playerId) => [
          playerId,
          ranksByPlayerId.get(playerId) ?? '',
        ]),
      ),
    }))
    setPodResultErrors((current) => ({ ...current, [pod.id]: '' }))
    setEditingPodResults((current) =>
      current.includes(pod.id) ? current : [...current, pod.id],
    )
  }

  function savePodResult(
    event: FormEvent<HTMLFormElement>,
    roundId: string,
    pod: Pod,
  ) {
    event.preventDefault()
    if (selectedTournament?.closedAt) {
      return
    }
    const draft = podResultDrafts[pod.id] ?? {}
    if (
      !selectedTournament ||
      !isSupportedPodSize(selectedTournament.format, pod.playerIds.length)
    ) {
      setPodResultErrors((current) => ({
        ...current,
        [pod.id]:
          selectedTournament?.format === 'two-headed-giant'
            ? 'Solo se pueden registrar resultados para una mesa de 2 parejas.'
            : 'Solo se pueden registrar resultados para pods de 3 o 4 jugadores.',
      }))
      return
    }

    const placementResult = buildPlacementsFromRanks(
      pod.playerIds,
      draft,
      selectedTournament.format,
    )
    if (!placementResult.valid) {
      setPodResultErrors((current) => ({
        ...current,
        [pod.id]: placementResult.error,
      }))
      return
    }

    updateSelectedTournament((tournament) => ({
      ...tournament,
      rounds: tournament.rounds.map((round) =>
        round.id === roundId
          ? {
              ...round,
              pods: round.pods.map((currentPod) =>
                currentPod.id === pod.id
                  ? {
                      ...currentPod,
                      result: { placements: placementResult.placements },
                    }
                  : currentPod,
              ),
            }
          : round,
      ),
    }))
    setEditingPodResults((current) =>
      current.filter((editingPodId) => editingPodId !== pod.id),
    )
    setPodResultErrors((current) => ({ ...current, [pod.id]: '' }))
  }

  function cancelPodResultEdit(podId: string) {
    setEditingPodResults((current) =>
      current.filter((editingId) => editingId !== podId),
    )
    setPodResultErrors((current) => ({ ...current, [podId]: '' }))
  }

  function getUnassignedPlayers(round: TournamentRound) {
    const assignedPlayerIds = new Set(
      round.pods.flatMap((pod) => pod.playerIds),
    )
    return (
      selectedTournament?.players.filter(
        (player) => !assignedPlayerIds.has(player.id),
      ) ?? []
    )
  }

  function applyApprovedProposal(proposal: ResultProposal) {
    if (!selectedTournament || selectedTournament.closedAt) {
      return
    }

    const tournamentId = selectedTournament.id
    setTournaments((current) =>
      current.map((tournament) =>
        tournament.id !== tournamentId
          ? tournament
          : {
              ...tournament,
              rounds: tournament.rounds.map((round) =>
                round.id !== proposal.roundId
                  ? round
                  : {
                      ...round,
                      pods: round.pods.map((pod) =>
                        pod.id !== proposal.podId
                          ? pod
                          : {
                              ...pod,
                              result: { placements: proposal.placements },
                            },
                      ),
                    },
              ),
            },
      ),
    )
  }

  if (!adminMode && adminEditingRecord) {
    return (
      <TournamentWorkspace
        adminMode
        adminOwnerId={adminEditingRecord.ownerId}
        initialTournaments={[adminEditingRecord.tournament]}
        initialAutoSyncEnabled={false}
        key={adminEditingRecord.tournament.id}
        onAdminSave={(tournament) =>
          saveAdminTournament(tournament, adminEditingRecord.ownerId)
        }
        onReturnToAdmin={() => setAdminEditingRecord(null)}
        onSignOut={onSignOut}
        userId={userId}
      />
    )
  }

  return (
    <main className="app-shell min-h-screen px-4 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto w-full max-w-6xl">
        <header className="mb-8 flex flex-wrap items-center gap-4 sm:mb-12">
          <img
            alt=""
            aria-hidden="true"
            className="size-14 shrink-0 rounded-2xl shadow-lg shadow-black/30 sm:size-16"
            src="/icons/commander-mark.svg"
          />
          <div className="min-w-0 flex-1">
            <p className="app-kicker text-xs font-semibold tracking-[0.2em] text-amber-300 uppercase">
              Tu mesa, tu torneo
            </p>
            <h1>Commander Tournament</h1>
          </div>
          {adminMode && onReturnToAdmin && (
            <button
              className="shrink-0 rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-300/10"
              onClick={onReturnToAdmin}
              type="button"
            >
              Volver al panel admin
            </button>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!adminMode && (
              <>
                <button
                  aria-label={
                    syncReview
                      ? 'Hay conflictos de sincronización pendientes'
                      : displayedSyncStatus === 'synced'
                        ? 'Comprobar sincronización'
                        : displayedSyncStatus === 'pending'
                          ? 'Sincronizar cambios pendientes'
                          : displayedSyncStatus === 'error'
                            ? 'Reintentar sincronización'
                            : 'Sincronizando'
                  }
                  aria-live="polite"
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition sm:text-sm ${
                    displayedSyncStatus === 'error'
                      ? 'border-rose-400/40 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20'
                      : displayedSyncStatus === 'synced'
                        ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20'
                        : displayedSyncStatus === 'syncing'
                          ? 'border-sky-400/40 bg-sky-400/10 text-sky-200'
                          : 'border-amber-300/40 bg-amber-300/10 text-amber-100 hover:bg-amber-300/20'
                  } disabled:cursor-wait disabled:opacity-60`}
                  disabled={
                    isDeletingTournament ||
                    syncStatus === 'syncing' ||
                    syncReview !== null
                  }
                  onClick={() => void beginSync()}
                  title={
                    displayedSyncStatus === 'synced'
                      ? 'Comprobar la sincronización ahora'
                      : undefined
                  }
                  type="button"
                >
                  {syncReview !== null
                    ? 'Conflictos'
                    : displayedSyncStatus === 'syncing'
                      ? 'Sincronizando…'
                      : displayedSyncStatus === 'error'
                        ? 'Reintentar'
                        : displayedSyncStatus === 'pending'
                          ? 'Sincronizar'
                          : 'Sincronizado'}
                </button>
                <details className="relative">
                  <summary
                    aria-label="Opciones de sincronización"
                    className="cursor-pointer list-none rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 sm:text-sm"
                  >
                    Opciones
                  </summary>
                  <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-white/10 bg-slate-900 p-4 shadow-xl shadow-black/30">
                    <p className="text-sm text-slate-300">
                      {autoSyncEnabled
                        ? 'La sincronización automática está activada para esta cuenta.'
                        : 'La sincronización automática solo empieza si la activas.'}
                    </p>
                    <button
                      aria-pressed={autoSyncEnabled}
                      className="mt-3 w-full rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-wait disabled:opacity-50"
                      disabled={autoSyncPreferenceSaving}
                      onClick={() => void changeAutomaticSync(!autoSyncEnabled)}
                      type="button"
                    >
                      {autoSyncPreferenceSaving
                        ? 'Guardando preferencia…'
                        : autoSyncEnabled
                          ? 'Desactivar sincronización automática'
                          : 'Activar sincronización automática'}
                    </button>
                  </div>
                </details>
              </>
            )}
            <button
              className="shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 sm:text-sm"
              onClick={() => {
                setSignOutError('')
                void onSignOut().catch(() =>
                  setSignOutError('No se pudo cerrar la sesión. Inténtalo de nuevo.'),
                )
              }}
              type="button"
            >
              Cerrar sesión
            </button>
          </div>
        </header>

        {signOutError && (
          <p className="mb-6 text-sm text-rose-300" role="alert">
            {signOutError}
          </p>
        )}

        {adminMode && (
          <div className="mb-6 space-y-2" aria-live="polite">
            <p className="text-sm text-slate-300" role="status">
              {adminSaving ? 'Guardando cambios en Supabase…' : 'Modo de gestión admin'}
            </p>
            {adminSaveError && (
              <p
                className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
                role="alert"
              >
                {adminSaveError}
              </p>
            )}
          </div>
        )}

        {!adminMode &&
          Boolean(
            autoSyncPreferenceError ||
              syncError ||
              (syncReview !== null && syncReview.conflicts.length > 0),
          ) && (
            <section
              aria-labelledby="sync-issues-heading"
              className="mb-6 rounded-2xl border border-white/10 bg-slate-900/80 p-4 shadow-lg shadow-black/10 sm:p-5"
            >
              <h2 className="sr-only" id="sync-issues-heading">
                Avisos de sincronización
              </h2>
              {autoSyncPreferenceError && (
                <p
                  className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
                  role="alert"
                >
                  {autoSyncPreferenceError}
                </p>
              )}

              {syncError && (
                <p
                  className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
                  role="alert"
                >
                  {syncError}
                </p>
              )}

              {syncReview && syncReview.conflicts.length > 0 && (
                <div className="mt-5 space-y-4 border-t border-white/10 pt-5">
                  <div>
                    <h3 className="text-base font-semibold text-slate-100">
                      Resuelve los conflictos
                    </h3>
                    <p className="app-supporting-copy text-sm text-slate-300">
                      {syncReview.automatic
                        ? 'La sincronización automática está pausada. Elige qué versión conservar para cada torneo; la sincronización continuará al resolverlos todos.'
                        : 'Elige qué versión conservar para cada torneo. La sincronización comenzará al resolverlos todos.'}
                      {' '}No se sobrescribirá ninguna versión antes de terminar
                      esta revisión.
                    </p>
                    <div className="mt-4 space-y-3">
                      {syncReview.conflicts.map((conflict, index) => (
                        <fieldset
                          className="rounded-xl border border-amber-300/25 bg-slate-950/60 p-4 shadow-sm shadow-black/20"
                          key={conflict.id}
                        >
                          <legend className="px-1 text-sm font-semibold text-amber-100">
                            Conflicto {index + 1}: {conflict.local.name}
                          </legend>
                          <div className="grid gap-3 sm:grid-cols-2">
                            {(
                              [
                                ['local', 'Usar versión local', conflict.local],
                                [
                                  'remote',
                                  'Usar versión de Supabase',
                                  conflict.remote,
                                ],
                              ] as const
                            ).map(([choice, label, tournament]) => (
                              <label
                                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
                                  conflict.choice === choice
                                    ? 'border-amber-300/60 bg-amber-300/10 text-amber-100'
                                    : 'border-slate-700 text-slate-300 hover:border-slate-500'
                                }`}
                                key={choice}
                              >
                                <input
                                  checked={conflict.choice === choice}
                                  className="mt-0.5 accent-amber-300"
                                  name={`conflict-${conflict.id}`}
                                  onChange={() =>
                                    chooseConflict(conflict.id, choice)
                                  }
                                  type="radio"
                                />
                                <span className="min-w-0">
                                  <span className="block font-medium">
                                    {label}
                                  </span>
                                  <span className="mt-1 block text-xs text-slate-300">
                                    {tournament.players.length}{' '}
                                    {tournament.players.length === 1
                                      ? tournament.format === 'two-headed-giant'
                                        ? 'pareja'
                                        : 'jugador'
                                      : tournament.format === 'two-headed-giant'
                                        ? 'parejas'
                                        : 'jugadores'}
                                    {' · '}
                                    {tournament.rounds.length}{' '}
                                    {tournament.rounds.length === 1
                                      ? 'ronda'
                                      : 'rondas'}
                                  </span>
                                </span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-950/50 p-4">
                    <p className="text-sm text-slate-300">
                      Al elegir una versión para cada conflicto, empezará la
                      sincronización.
                    </p>
                    <button
                      className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
                      onClick={cancelSyncReview}
                      type="button"
                    >
                      Cancelar revisión
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

        {selectedTournament && (
          <nav
            aria-label="Accesos rápidos del torneo"
            className="sticky top-2 z-20 mb-4 -mx-1 flex gap-2 overflow-x-auto rounded-xl border border-white/10 bg-slate-950/95 p-2 shadow-lg shadow-black/20 backdrop-blur lg:hidden"
          >
            <a
              className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-amber-300/40 hover:text-amber-100"
              href="#participants-section"
            >
              Participantes
            </a>
            <a
              className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-amber-300/40 hover:text-amber-100"
              href="#rounds-heading"
            >
              Rondas
            </a>
            <a
              className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-amber-300/40 hover:text-amber-100"
              href="#standings-heading"
            >
              Clasificación
            </a>
          </nav>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-8">
          <section
            aria-labelledby="create-tournament-heading"
            className={`${selectedTournament ? 'order-2' : 'order-1'} lg:order-1 rounded-2xl border border-white/10 bg-slate-900/80 p-5 shadow-xl shadow-black/10 sm:p-7 ${
              adminMode ? 'hidden' : ''
            }`}
          >
            <div className="mb-6">
              <p className="app-kicker text-sm font-semibold text-amber-300">
                Empieza una nueva partida
              </p>
              <h2 id="create-tournament-heading">Crear torneo</h2>
              <p className="app-supporting-copy text-sm text-slate-400">
                Añade los detalles y prepara la lista de participantes.
              </p>
            </div>

            <form className="space-y-5" onSubmit={createTournament}>
              <div>
                <label
                  className="mb-2 block text-sm font-medium text-slate-200"
                  htmlFor="tournament-name"
                >
                  Nombre del torneo <span className="text-amber-300">*</span>
                </label>
                <input
                  autoComplete="off"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white placeholder:text-slate-500"
                  id="tournament-name"
                  onChange={(event) => {
                    setTournamentName(event.target.value)
                    setTournamentError('')
                  }}
                  placeholder="Ej. Noche de Commander"
                  required
                  type="text"
                  value={tournamentName}
                />
              </div>

              <fieldset>
                <legend className="mb-2 block text-sm font-medium text-slate-200">
                  Modalidad
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    {
                      value: 'commander' as const,
                      title: 'Commander',
                      details: 'Mesas de 3 o 4 jugadores',
                    },
                    {
                      value: 'two-headed-giant' as const,
                      title: 'Dos Cabezas',
                      details: 'Parejas',
                    },
                  ].map((option) => (
                    <label
                      className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${
                        tournamentFormat === option.value
                          ? 'border-amber-300/70 bg-amber-300/10'
                          : 'border-slate-700 bg-slate-950/40 hover:border-slate-500'
                      }`}
                      key={option.value}
                    >
                      <input
                        checked={tournamentFormat === option.value}
                        className="mt-1 accent-amber-300"
                        name="tournament-format"
                        onChange={() => setTournamentFormat(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span>
                        <span className="block font-semibold text-slate-100">
                          {option.title}
                        </span>
                        <span className="mt-1 block text-xs text-slate-400">
                          {option.details}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label
                    className="mb-2 block text-sm font-medium text-slate-200"
                    htmlFor="tournament-date"
                  >
                    Fecha <span className="text-slate-500">(opcional)</span>
                  </label>
                  <input
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white"
                    id="tournament-date"
                    onChange={(event) => setTournamentDate(event.target.value)}
                    type="date"
                    value={tournamentDate}
                  />
                </div>
                <div>
                  <label
                    className="mb-2 block text-sm font-medium text-slate-200"
                    htmlFor="tournament-location"
                  >
                    Ubicación <span className="text-slate-500">(opcional)</span>
                  </label>
                  <input
                    autoComplete="off"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white placeholder:text-slate-500"
                    id="tournament-location"
                    onChange={(event) =>
                      setTournamentLocation(event.target.value)
                    }
                    placeholder="Tienda, casa…"
                    type="text"
                    value={tournamentLocation}
                  />
                </div>
              </div>

              {tournamentError && (
                <p className="text-sm text-rose-300" role="alert">
                  {tournamentError}
                </p>
              )}

              <button
                className="w-full rounded-lg bg-amber-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-amber-200 sm:w-auto"
                type="submit"
              >
                Crear torneo
              </button>
            </form>

            <div className="mt-8 border-t border-white/10 pt-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg!">Tus torneos</h2>
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-slate-300">
                  {tournaments.length}
                </span>
              </div>

              {tournaments.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-700 px-4 py-5 text-sm text-slate-400">
                  Todavía no hay torneos. Crea uno para empezar.
                </p>
              ) : (
                <ul className="space-y-2">
                  {tournaments.map((tournament) => (
                    <li key={tournament.id}>
                      <button
                        aria-pressed={tournament.id === selectedTournamentId}
                        className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                          tournament.id === selectedTournamentId
                            ? 'border-amber-300/60 bg-amber-300/10 text-amber-100'
                            : 'border-slate-800 bg-slate-950/60 text-slate-200 hover:border-slate-600'
                        }`}
                        onClick={() => {
                          pendingRoundScrollId.current = null
                          setSelectedTournamentId(tournament.id)
                          setTournamentDeleteError('')
                          setExpandedRoundId(
                            tournament.rounds.find(
                              ({ id }) => id === tournament.activeRoundId,
                            )?.id ??
                              tournament.rounds[
                                tournament.rounds.length - 1
                              ]?.id ??
                              null,
                          )
                        }}
                        type="button"
                      >
                        <span className="block font-medium">
                          {tournament.name}
                        </span>
                        <span className="mt-1 block text-xs text-slate-400">
                          {tournament.players.length}{' '}
                          {tournament.players.length === 1
                            ? tournament.format === 'two-headed-giant'
                              ? 'pareja'
                              : 'jugador'
                            : tournament.format === 'two-headed-giant'
                              ? 'parejas'
                              : 'jugadores'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section
            id="participants-section"
            aria-labelledby={
              isEditingTournament ? 'tournament-edit-heading' : 'players-heading'
            }
            className={`${selectedTournament ? 'order-1' : 'order-2'} lg:order-2 scroll-mt-24 rounded-2xl border border-white/10 bg-slate-900/80 p-5 shadow-xl shadow-black/10 sm:p-7`}
          >
            {selectedTournament ? (
              <>
                <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="app-kicker text-sm font-semibold text-amber-300">
                      Torneo seleccionado
                    </p>
                    {isEditingTournament ? (
                      <form
                        aria-labelledby="tournament-edit-heading"
                        className="mt-3 w-full max-w-xl space-y-4"
                        onSubmit={(event) => void saveTournamentDetails(event)}
                      >
                        <h2 className="text-lg!" id="tournament-edit-heading">
                          Editar datos del torneo
                        </h2>
                        <div>
                          <label
                            className="mb-2 block text-sm font-medium text-slate-200"
                            htmlFor="edit-tournament-name"
                          >
                            Nombre del torneo{' '}
                            <span className="text-amber-300">*</span>
                          </label>
                          <input
                            aria-describedby={
                              tournamentEditError
                                ? 'tournament-edit-error'
                                : undefined
                            }
                            aria-invalid={Boolean(tournamentEditError)}
                            autoComplete="off"
                            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white"
                            id="edit-tournament-name"
                            onChange={(event) => {
                              setTournamentEditName(event.target.value)
                              setTournamentEditError('')
                            }}
                            required
                            type="text"
                            value={tournamentEditName}
                          />
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div>
                            <label
                              className="mb-2 block text-sm font-medium text-slate-200"
                              htmlFor="edit-tournament-date"
                            >
                              Fecha <span className="text-slate-500">(opcional)</span>
                            </label>
                            <input
                              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white"
                              id="edit-tournament-date"
                              onChange={(event) =>
                                setTournamentEditDate(event.target.value)
                              }
                              type="date"
                              value={tournamentEditDate}
                            />
                          </div>
                          <div>
                            <label
                              className="mb-2 block text-sm font-medium text-slate-200"
                              htmlFor="edit-tournament-location"
                            >
                              Ubicación{' '}
                              <span className="text-slate-500">(opcional)</span>
                            </label>
                            <input
                              autoComplete="off"
                              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white"
                              id="edit-tournament-location"
                              onChange={(event) =>
                                setTournamentEditLocation(event.target.value)
                              }
                              type="text"
                              value={tournamentEditLocation}
                            />
                          </div>
                        </div>
                        {tournamentEditError && (
                          <p
                            className="text-sm text-rose-300"
                            id="tournament-edit-error"
                            role="alert"
                          >
                            {tournamentEditError}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-wait disabled:opacity-50"
                            disabled={adminSaving}
                            type="submit"
                          >
                            {adminSaving ? 'Guardando…' : 'Guardar cambios'}
                          </button>
                          <button
                            className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-white/10"
                            disabled={adminSaving}
                            onClick={cancelTournamentEdit}
                            type="button"
                          >
                            Cancelar
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <h2 className="scroll-mt-24" id="players-heading">
                          {selectedTournament.name}
                        </h2>
                        <p className="mt-2 text-sm font-medium text-amber-200">
                          {selectedTournament.format === 'two-headed-giant'
                            ? 'Dos Cabezas · parejas · 4 puntos por victoria'
                            : 'Commander · mesas individuales'}
                        </p>
                        {(selectedTournament.date ||
                          selectedTournament.location) && (
                          <p className="app-supporting-copy text-sm text-slate-400">
                            {[
                              selectedTournament.date &&
                                new Intl.DateTimeFormat('es', {
                                  dateStyle: 'long',
                                }).format(
                                  new Date(
                                    `${selectedTournament.date}T00:00:00`,
                                  ),
                                ),
                              selectedTournament.location,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1.5 text-sm font-semibold text-amber-200">
                    {selectedTournament.players.length}{' '}
                    {selectedTournament.players.length === 1
                      ? participantLabel
                      : participantsLabel}
                  </span>
                </div>

                {!isEditingTournament && (
                  <div className="mb-6 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={adminSaving || tournamentIsClosed}
                        onClick={startEditingTournament}
                        type="button"
                      >
                        Editar torneo
                      </button>
                      {tournamentIsClosed ? (
                        <button
                          className="rounded-lg border border-emerald-300/40 px-4 py-2.5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-300/10 disabled:cursor-wait disabled:opacity-50"
                          disabled={adminSaving}
                          onClick={() => void reopenSelectedTournament()}
                          type="button"
                        >
                          Reabrir torneo
                        </button>
                      ) : (
                        <button
                          className="rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-wait disabled:opacity-50"
                          disabled={adminSaving}
                          onClick={() => void closeSelectedTournament()}
                          type="button"
                        >
                          Cerrar torneo
                        </button>
                      )}
                      <button
                        aria-describedby="tournament-backup-help"
                        className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
                        disabled={adminSaving}
                        onClick={createSelectedTournamentBackup}
                        type="button"
                      >
                        Descargar copia de seguridad
                      </button>
                      {!adminMode && (
                        <button
                          className="rounded-lg border border-rose-400/40 px-4 py-2.5 text-sm font-semibold text-rose-200 transition hover:bg-rose-400/10 disabled:cursor-wait disabled:opacity-50"
                          disabled={
                            isDeletingTournament ||
                            syncStatus === 'syncing' ||
                            syncReview !== null
                          }
                          onClick={() => void deleteSelectedTournament()}
                          type="button"
                        >
                          {isDeletingTournament ? 'Eliminando…' : 'Eliminar torneo'}
                        </button>
                      )}
                    </div>
                    <p
                      className="app-supporting-copy text-sm text-slate-400"
                      id="tournament-backup-help"
                    >
                      Incluye participantes, rondas, mesas y resultados oficiales. No incluye el enlace QR ni resultados pendientes de aprobación.
                    </p>
                    {backupNotice && (
                      <p className="text-sm text-emerald-200" role="status">
                        {backupNotice}
                      </p>
                    )}
                    {backupError && (
                      <p className="text-sm text-rose-200" role="alert">
                        {backupError}
                      </p>
                    )}
                    {tournamentDeleteError && (
                      <p className="text-sm text-rose-200" role="alert">
                        {tournamentDeleteError}
                      </p>
                    )}
                    {tournamentIsClosed && (
                      <p className="rounded-lg border border-emerald-300/20 bg-emerald-300/5 px-4 py-3 text-sm text-emerald-100">
                        Torneo finalizado. El QR muestra la clasificación y las
                        acciones de organización están bloqueadas.
                      </p>
                    )}
                    {tournamentStatusError && (
                      <p
                        className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
                        role="alert"
                      >
                        {tournamentStatusError}
                      </p>
                    )}
                    {tournamentStatusNotice && (
                      <p className="text-sm text-emerald-200" role="status">
                        {tournamentStatusNotice}
                      </p>
                    )}
                  </div>
                )}

                <Suspense
                  fallback={
                    <p aria-live="polite" className="mb-6 text-sm text-slate-300" role="status">
                      Cargando controles del tablero público…
                    </p>
                  }
                >
                  <PublicTournamentManager
                    adminSaving={adminSaving}
                    key={selectedTournament.id}
                    format={selectedTournament.format}
                    tournamentId={selectedTournament.id}
                  />
                </Suspense>

                {registrationClosed && (
                  <p
                    className="mb-3 rounded-lg border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-sm text-amber-100"
                    role="status"
                  >
                    La inscripción se cerró al iniciar la primera ronda. Ya no
                    se pueden añadir participantes.
                  </p>
                )}

                <form
                  className="mb-6 flex flex-col gap-3 sm:flex-row"
                  onSubmit={addPlayer}
                >
                  <div className="min-w-0 flex-1">
                    <label className="sr-only" htmlFor="player-name">
                      Nombre de la {participantLabel}
                    </label>
                    <input
                      autoComplete="off"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white placeholder:text-slate-500"
                      disabled={tournamentIsClosed || registrationClosed}
                      id="player-name"
                      onChange={(event) => {
                        setPlayerName(event.target.value)
                        setPlayerError('')
                      }}
                      placeholder={`Nombre de la ${participantLabel}`}
                      required
                      type="text"
                      value={playerName}
                    />
                  </div>
                  <button
                    className="rounded-lg border border-amber-300/50 px-5 py-3 font-semibold text-amber-200 transition hover:bg-amber-300/10"
                    disabled={adminSaving || tournamentIsClosed || registrationClosed}
                    type="submit"
                  >
                    Añadir {participantLabel}
                  </button>
                </form>

                {playerError && (
                  <p
                    className="app-error-copy text-sm text-rose-300"
                    role="alert"
                  >
                    {playerError}
                  </p>
                )}

                {selectedTournament.players.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-700 px-5 py-10 text-center">
                    <p className="font-medium text-slate-200">
                      Aún no hay participantes
                    </p>
                    <p className="app-supporting-copy text-sm text-slate-400">
                      {selectedTournament.format === 'two-headed-giant'
                        ? 'Añade el nombre de cada pareja para crear sus mesas.'
                        : 'Añade el primer jugador para completar la mesa.'}
                    </p>
                  </div>
                ) : (
                  <ul
                    aria-label={
                      selectedTournament.format === 'two-headed-giant'
                        ? 'Lista de parejas'
                        : 'Lista de jugadores'
                    }
                    className="divide-y divide-white/10 rounded-xl border border-white/10"
                  >
                    {selectedTournament.players.map((player, index) => (
                      <li
                        className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                        key={player.id}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-amber-200"
                          >
                            {index + 1}
                          </span>
                          {editingPlayerId === player.id ? (
                            <form
                              className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row"
                              onSubmit={(event) =>
                                void savePlayerName(event, player.id)
                              }
                            >
                              <div className="min-w-0 flex-1">
                                <label
                                  className="sr-only"
                                  htmlFor={`edit-player-${player.id}`}
                                >
                                  Nuevo nombre de {player.name}
                                </label>
                                <input
                                  aria-describedby={
                                    playerEditError
                                      ? `player-edit-error-${player.id}`
                                      : undefined
                                  }
                                  aria-invalid={Boolean(playerEditError)}
                                  autoComplete="off"
                                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-base text-white"
                                  id={`edit-player-${player.id}`}
                                  onChange={(event) => {
                                    setPlayerEditName(event.target.value)
                                    setPlayerEditError('')
                                  }}
                                  required
                                  type="text"
                                  value={playerEditName}
                                />
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  className="rounded-lg bg-amber-300 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-wait disabled:opacity-50"
                                  disabled={adminSaving}
                                  type="submit"
                                >
                                  {adminSaving ? 'Guardando…' : 'Guardar'}
                                </button>
                                <button
                                  className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10"
                                  disabled={adminSaving}
                                  onClick={() => {
                                    setEditingPlayerId(null)
                                    setPlayerEditError('')
                                  }}
                                  type="button"
                                >
                                  Cancelar
                                </button>
                              </div>
                            </form>
                          ) : (
                            <span className="truncate font-medium text-slate-100">
                              {player.name}
                            </span>
                          )}
                        </div>
                        {editingPlayerId === player.id ? (
                          playerEditError && (
                            <p
                              className="text-sm text-rose-300"
                              id={`player-edit-error-${player.id}`}
                              role="alert"
                            >
                              {playerEditError}
                            </p>
                          )
                        ) : (
                          <div className="flex shrink-0 gap-1">
                            <button
                              aria-label={`Cambiar nombre de ${player.name}`}
                              className="rounded-md px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-300/10"
                              disabled={adminSaving || tournamentIsClosed}
                              onClick={() =>
                                startEditingPlayer(player.id, player.name)
                              }
                              type="button"
                            >
                              Cambiar nombre
                            </button>
                            <button
                              aria-label={`Quitar a ${player.name}`}
                              className="rounded-md px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-rose-400/10 hover:text-rose-300"
                              disabled={adminSaving || tournamentIsClosed}
                              onClick={() => removePlayer(player.id)}
                              type="button"
                            >
                              Quitar
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                <section
                  aria-labelledby="rounds-heading"
                  className="mt-8 border-t border-white/10 pt-6"
                >
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="app-kicker text-sm font-semibold text-amber-300">
                        Organización manual
                      </p>
                      <h2 className="scroll-mt-24" id="rounds-heading">
                        {selectedTournament.format === 'two-headed-giant'
                          ? 'Rondas y mesas'
                          : 'Rondas y pods'}
                      </h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="rounded-lg border border-amber-300/40 px-4 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-300/10"
                        disabled={adminSaving || tournamentIsClosed}
                        onClick={createRound}
                        type="button"
                      >
                        Crear ronda
                      </button>
                      <button
                        className="rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-200"
                        disabled={adminSaving || tournamentIsClosed}
                        onClick={() => void generateRoundAutomatically(null)}
                        type="button"
                      >
                        Crear ronda y generar mesas
                      </button>
                    </div>
                  </div>

                  {controlRound && selectedTournament && (
                    <section
                      aria-label={`Resumen de la ronda ${controlRoundNumber}`}
                      className="mb-5 rounded-xl border border-emerald-300/20 bg-emerald-300/5 p-4 sm:p-5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="app-kicker text-xs font-semibold text-emerald-200">
                            Estado de la ronda {controlRoundNumber}
                          </p>
                          <p className="mt-1 text-sm text-slate-300">
                            {selectedTournament.activeRoundId === controlRound.id
                              ? 'Esta ronda es la que se muestra en el QR.'
                              : 'Ronda más reciente. Selecciónala para mostrarla en el QR.'}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-xs text-slate-400">
                            Propuestas: actualización automática cada 15 s
                          </span>
                          <button
                            className="rounded-lg border border-slate-500 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:bg-white/10"
                            onClick={() => window.print()}
                            type="button"
                          >
                            Imprimir torneo / guardar PDF
                          </button>
                        </div>
                      </div>

                      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-lg border border-white/10 bg-slate-950/50 px-4 py-3">
                          <dt className="text-sm text-slate-400">
                            {selectedTournament.format === 'two-headed-giant'
                              ? 'Mesas con resultado oficial'
                              : 'Pods con resultado oficial'}
                          </dt>
                          <dd className="mt-1 text-2xl font-semibold text-white">
                            {controlRoundResultsCount}/{controlRound.pods.length}
                          </dd>
                        </div>
                        <div className="rounded-lg border border-white/10 bg-slate-950/50 px-4 py-3">
                          <dt className="text-sm text-slate-400">
                            Propuestas pendientes
                          </dt>
                          <dd className="mt-1 text-2xl font-semibold text-white">
                            {currentRoundPendingCount ?? '…'}
                          </dd>
                        </div>
                        <div className="rounded-lg border border-white/10 bg-slate-950/50 px-4 py-3">
                          <dt className="text-sm text-slate-400">
                            {selectedTournament.format === 'two-headed-giant'
                              ? 'Parejas sin asignar'
                              : 'Jugadores sin asignar'}
                          </dt>
                          <dd className="mt-1 text-2xl font-semibold text-white">
                            {controlRoundUnassignedCount}
                          </dd>
                        </div>
                      </dl>

                      <p
                        aria-live="polite"
                        className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
                          tournamentIsClosed
                            ? 'border-emerald-300/20 bg-emerald-300/5 text-emerald-100'
                            : nextRoundReadinessError
                              ? 'border-amber-300/20 bg-amber-300/5 text-amber-100'
                              : 'border-emerald-300/20 bg-emerald-300/5 text-emerald-100'
                        }`}
                        role="status"
                      >
                        {tournamentIsClosed
                          ? 'Torneo finalizado; el QR muestra la clasificación final.'
                          : nextRoundReadinessError
                            ? `Para generar la siguiente ronda: ${nextRoundReadinessError.replace('No se puede avanzar:', '').trim()}`
                            : 'Rondas completas. Ya puedes generar la siguiente ronda; no hay un límite fijo.'}
                      </p>
                    </section>
                  )}

                  {controlRound && selectedTournament && createPortal(
                    <section
                      aria-label="Informe imprimible del torneo"
                      className="tournament-print-report"
                    >
                      <header className="tournament-print-header">
                        <img
                          alt=""
                          aria-hidden="true"
                          src="/icons/commander-mark.svg"
                        />
                        <div>
                          <p className="tournament-print-kicker">
                            Commander Tournament
                          </p>
                          <h1>{selectedTournament.name}</h1>
                          <p>
                            {selectedTournament.format === 'two-headed-giant'
                              ? 'Dos Cabezas · parejas'
                              : 'Commander · individual'}
                            {selectedTournament.date && (
                              <>
                                {' · '}
                                {new Intl.DateTimeFormat('es', {
                                  dateStyle: 'long',
                                }).format(
                                  new Date(
                                    `${selectedTournament.date}T00:00:00`,
                                  ),
                                )}
                              </>
                            )}
                            {selectedTournament.location &&
                              ` · ${selectedTournament.location}`}
                          </p>
                        </div>
                      </header>

                      <section className="tournament-print-section">
                        <div className="tournament-print-section-heading">
                          <h2>
                            Todas las rondas · {selectedTournament.rounds.length}
                          </h2>
                          <p>
                            {selectedTournament.players.length}{' '}
                            {selectedTournament.format === 'two-headed-giant'
                              ? selectedTournament.players.length === 1
                                ? 'pareja'
                                : 'parejas'
                              : selectedTournament.players.length === 1
                                ? 'jugador'
                                : 'jugadores'}
                            {' · Resultados oficiales junto a cada nombre'}
                          </p>
                        </div>
                        <div
                          className="tournament-print-rounds-grid"
                          style={{
                            gridTemplateColumns: `repeat(${Math.min(
                              3,
                              selectedTournament.rounds.length,
                            )}, minmax(0, 1fr))`,
                          }}
                        >
                          {selectedTournament.rounds.map((round, roundIndex) => {
                            const assignedPlayerIds = new Set(
                              round.pods.flatMap((pod) => pod.playerIds),
                            )
                            const unassignedPlayers =
                              selectedTournament.players.filter(
                                (player) =>
                                  !assignedPlayerIds.has(player.id),
                              )

                            return (
                              <section
                                className="tournament-print-round"
                                key={round.id}
                              >
                                <h3>Ronda {roundIndex + 1}</h3>
                                {round.pods.length > 0 ? (
                                  <div className="tournament-print-tables">
                                    {round.pods.map((pod, podIndex) => (
                                      <article
                                        className="tournament-print-card"
                                        key={pod.id}
                                      >
                                        <h4>Mesa {podIndex + 1}</h4>
                                        <ul>
                                          {pod.playerIds.map((playerId) => (
                                            <li
                                              className="tournament-print-player-line"
                                              key={playerId}
                                            >
                                              <span className="tournament-print-player-name">
                                                {selectedTournament.players.find(
                                                  (player) =>
                                                    player.id === playerId,
                                                )?.name ??
                                                  'Participante no disponible'}
                                              </span>
                                              <span className="tournament-print-player-result">
                                                {getPodParticipantPrintResult(
                                                  pod,
                                                  playerId,
                                                  selectedTournament.format,
                                                )}
                                              </span>
                                            </li>
                                          ))}
                                        </ul>
                                      </article>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="tournament-print-pending">
                                    Aún no hay mesas.
                                  </p>
                                )}
                                {unassignedPlayers.length > 0 && (
                                  <p className="tournament-print-unassigned">
                                    <strong>Sin asignar: </strong>
                                    {unassignedPlayers
                                      .map((player) => player.name)
                                      .join(', ')}
                                  </p>
                                )}
                              </section>
                            )
                          })}
                        </div>
                      </section>

                      <section className="tournament-print-section tournament-print-standings-section">
                        <div className="tournament-print-section-heading">
                          <h2>
                            {tournamentIsClosed
                              ? 'Clasificación final'
                              : selectedTournament.format ===
                                  'two-headed-giant'
                                ? 'Clasificación acumulada de parejas'
                                : 'Clasificación acumulada'}
                          </h2>
                          <p>Solo cuentan los resultados oficiales aprobados.</p>
                        </div>
                        <table className="tournament-print-standings">
                          <thead>
                            <tr>
                              <th scope="col">Puesto</th>
                              <th scope="col">
                                {selectedTournament.format ===
                                'two-headed-giant'
                                  ? 'Pareja'
                                  : 'Jugador'}
                              </th>
                              <th scope="col">Puntos</th>
                            </tr>
                          </thead>
                          <tbody>
                            {standings.map((standing) => (
                              <tr key={standing.id}>
                                <td>{standing.position}</td>
                                <td>{standing.name}</td>
                                <td>{standing.points}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </section>

                      <footer className="tournament-print-footer">
                        Informe generado el{' '}
                        {new Intl.DateTimeFormat('es', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date())}
                      </footer>
                    </section>,
                    document.body,
                  )}

                  {roundGenerationError && (
                    <p
                      className="mb-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
                      role="alert"
                    >
                      {roundGenerationError}
                    </p>
                  )}

                  {selectedTournament.rounds.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-700 px-4 py-5 text-sm text-slate-400">
                      Todavía no hay rondas. Crea una para empezar a organizar
                      {selectedTournament.format === 'two-headed-giant'
                        ? 'las mesas.'
                        : 'los pods.'}
                    </p>
                  ) : (
                    <div className="space-y-5">
                      {selectedTournament.rounds.map((round, roundIndex) => {
                        const isRoundExpanded = expandedRoundId === round.id
                        const roundIsComplete =
                          getRoundCompletionError(selectedTournament, roundIndex) ===
                          null
                        const roundHasResults = round.pods.some(
                          (pod) => Boolean(pod.result),
                        )
                        const hasLaterRound =
                          roundIndex < selectedTournament.rounds.length - 1
                        const assignedPlayerIds = new Set(
                          round.pods.flatMap((pod) => pod.playerIds),
                        )
                        const unassignedPlayers =
                          getUnassignedPlayers(round)

                        return (
                          <section
                            aria-labelledby={`round-${round.id}-heading`}
                            className="scroll-mt-5 rounded-xl border border-slate-700/80 bg-slate-950/40 p-4 sm:p-5"
                            id={`round-${round.id}-section`}
                            key={round.id}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <h3
                                className="text-base font-semibold text-slate-100"
                                id={`round-${round.id}-heading`}
                              >
                                <button
                                  aria-controls={`round-${round.id}-content`}
                                  aria-expanded={isRoundExpanded}
                                  className="flex flex-wrap items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                                  onClick={() => {
                                    pendingRoundScrollId.current = null
                                    setExpandedRoundId(
                                      isRoundExpanded ? null : round.id,
                                    )
                                  }}
                                  type="button"
                                >
                                  <span>Ronda {roundIndex + 1}</span>
                                  <span className="text-sm font-normal text-slate-400">
                                    {round.pods.length}{' '}
                                    {round.pods.length === 1 ? 'mesa' : 'mesas'}
                                  </span>
                                  {selectedTournament.activeRoundId ===
                                    round.id && (
                                    <span className="rounded-full border border-emerald-300/30 px-2 py-0.5 text-xs font-medium text-emerald-200">
                                      En QR
                                    </span>
                                  )}
                                  <span
                                    aria-hidden="true"
                                    className="text-sm text-amber-200"
                                  >
                                    {isRoundExpanded ? '−' : '+'}
                                  </span>
                                </button>
                              </h3>
                            </div>

                            <div
                              hidden={!isRoundExpanded}
                              id={`round-${round.id}-content`}
                            >
                              <div className="mb-4 mt-4 flex flex-wrap justify-end gap-2">
                                <button
                                  aria-pressed={
                                    selectedTournament.activeRoundId === round.id
                                  }
                                  className="rounded-md border border-emerald-300/40 px-3 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-300/10 disabled:cursor-not-allowed disabled:opacity-60"
                                  disabled={
                                    adminSaving ||
                                    tournamentIsClosed ||
                                    selectedTournament.activeRoundId === round.id
                                  }
                                  onClick={() => {
                                    pendingRoundScrollId.current = round.id
                                    setExpandedRoundId(round.id)
                                    void updateSelectedTournament(
                                      (tournament) => ({
                                        ...tournament,
                                        activeRoundId: round.id,
                                      }),
                                    )
                                  }}
                                  type="button"
                                >
                                  {selectedTournament.activeRoundId === round.id
                                    ? 'Mostrando en QR'
                                    : 'Mostrar en QR'}
                                </button>
                                <button
                                  className="rounded-md border border-amber-300/40 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
                                  disabled={
                                    adminSaving ||
                                    tournamentIsClosed ||
                                    hasLaterRound ||
                                    roundHasResults
                                  }
                                  onClick={() =>
                                    void generateRoundAutomatically(round.id)
                                  }
                                  title={
                                    hasLaterRound
                                      ? 'No se pueden generar mesas en una ronda anterior cuando existe una ronda posterior.'
                                      : roundHasResults
                                        ? 'No se pueden regenerar las mesas de una ronda con resultados oficiales.'
                                        : undefined
                                  }
                                  type="button"
                                >
                                  Generar mesas automáticamente
                                </button>
                                <button
                                  className="rounded-md border border-slate-600 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
                                  disabled={
                                    adminSaving ||
                                    tournamentIsClosed ||
                                    roundIsComplete
                                  }
                                  onClick={() => addPod(round.id)}
                                  title={
                                    roundIsComplete
                                      ? 'No se pueden añadir mesas a una ronda completa.'
                                      : undefined
                                  }
                                  type="button"
                                >
                                  {selectedTournament.format === 'two-headed-giant'
                                    ? 'Añadir mesa'
                                    : 'Añadir pod'}
                                </button>
                                <button
                                  className="rounded-md border border-rose-400/40 px-3 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-50"
                                  disabled={
                                    adminSaving ||
                                    tournamentIsClosed ||
                                    round.pods.some((pod) => Boolean(pod.result))
                                  }
                                  onClick={() =>
                                    void deleteRound(round.id, roundIndex + 1)
                                  }
                                  title="Solo se pueden eliminar rondas sin resultados oficiales ni propuestas pendientes."
                                  type="button"
                                >
                                  Eliminar ronda
                                </button>
                              </div>

                            {round.pods.length === 0 ? (
                              <p className="mb-4 rounded-lg border border-dashed border-slate-700 px-4 py-4 text-sm text-slate-400">
                                Esta ronda todavía no tiene mesas.
                              </p>
                            ) : (
                              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                                {round.pods.map((pod, podIndex) => {
                                  const availablePlayers =
                                    selectedTournament.players.filter(
                                      (player) =>
                                        !assignedPlayerIds.has(player.id),
                                    )
                                  const podCapacity = getPodCapacity(
                                    selectedTournament.format,
                                  )
                                  const isFull =
                                    pod.playerIds.length >= podCapacity
                                  const selectionId = `pod-player-${pod.id}`
                                  const podResult = pod.result
                                  const resultPoints = podResult
                                    ? getPodPoints(
                                        podResult,
                                        pod.playerIds.length,
                                        selectedTournament.format,
                                      )
                                    : new Map<string, number>()

                                  return (
                                    <section
                                      aria-labelledby={`pod-${pod.id}-heading`}
                                      className="min-w-0 rounded-lg border border-slate-700 bg-slate-900/80 p-4"
                                      key={pod.id}
                                    >
                                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                        <h4
                                          className="text-sm font-semibold text-amber-100"
                                          id={`pod-${pod.id}-heading`}
                                        >
                                          {selectedTournament.format ===
                                          'two-headed-giant'
                                            ? 'Mesa'
                                            : 'Pod'}{' '}
                                          {podIndex + 1}
                                          <span className="ml-2 font-normal text-slate-400">
                                            {pod.playerIds.length}/{podCapacity}{' '}
                                            {participantsLabel}
                                          </span>
                                        </h4>
                                        <button
                                          aria-label={`Eliminar ${selectedTournament.format === 'two-headed-giant' ? 'mesa' : 'pod'} ${podIndex + 1} de la ronda ${roundIndex + 1}`}
                                          className="rounded-md border border-rose-400/35 px-2.5 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-50"
                                          disabled={
                                            adminSaving ||
                                            tournamentIsClosed ||
                                            Boolean(round.startedAt) ||
                                            Boolean(pod.result)
                                          }
                                          onClick={() =>
                                            void deletePod(
                                              round.id,
                                              pod.id,
                                              podIndex + 1,
                                              roundIndex + 1,
                                            )
                                          }
                                          title="Solo se puede eliminar antes de lanzar la ronda y si no tiene resultados."
                                          type="button"
                                        >
                                          Eliminar
                                        </button>
                                      </div>

                                      {pod.playerIds.length === 0 ? (
                                        <p className="mb-3 text-sm text-slate-400">
                                          Todavía no hay nadie asignado a esta mesa.
                                        </p>
                                      ) : (
                                        <ul className="mb-3 space-y-2">
                                          {pod.playerIds.map((playerId) => {
                                            const player =
                                              selectedTournament.players.find(
                                                ({ id }) => id === playerId,
                                              )
                                            if (!player) {
                                              return null
                                            }

                                            return (
                                              <li
                                                className="flex items-center justify-between gap-2 text-sm text-slate-200"
                                                key={player.id}
                                              >
                                                <span className="min-w-0 truncate">
                                                  {player.name}
                                                </span>
                                                <button
                                                  aria-label={`Quitar a ${player.name} de la ${selectedTournament.format === 'two-headed-giant' ? 'mesa' : 'pod'} ${podIndex + 1} de la ronda ${roundIndex + 1}`}
                                                  className="shrink-0 rounded px-2 py-1 text-xs text-slate-400 hover:bg-rose-400/10 hover:text-rose-300 disabled:opacity-50"
                                                  disabled={adminSaving || tournamentIsClosed}
                                                  onClick={() =>
                                                    unassignPlayer(
                                                      round.id,
                                                      pod.id,
                                                      player.id,
                                                    )
                                                  }
                                                  type="button"
                                                >
                                                  Quitar
                                                </button>
                                              </li>
                                            )
                                          })}
                                        </ul>
                                      )}

                                      <form
                                        className="flex flex-col gap-2"
                                        onSubmit={(event) => {
                                          event.preventDefault()
                                          assignPlayer(round.id, pod.id)
                                        }}
                                      >
                                        <label
                                          className="sr-only"
                                          htmlFor={selectionId}
                                        >
                                          Seleccionar {participantLabel} para la mesa{' '}
                                          {podIndex + 1} de la ronda{' '}
                                          {roundIndex + 1}
                                        </label>
                                        <select
                                          className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
                                          disabled={
                                            tournamentIsClosed ||
                                            isFull ||
                                            availablePlayers.length === 0
                                          }
                                          id={selectionId}
                                          onChange={(event) =>
                                            setPodSelections((current) => ({
                                              ...current,
                                              [pod.id]: event.target.value,
                                            }))
                                          }
                                          value={podSelections[pod.id] ?? ''}
                                        >
                                          <option value="">
                                            {isFull
                                              ? 'Mesa completa'
                                              : availablePlayers.length === 0
                                                ? `No hay ${participantsLabel} disponibles`
                                                : `Selecciona ${participantLabel}`}
                                          </option>
                                          {availablePlayers.map((player) => (
                                            <option
                                              key={player.id}
                                              value={player.id}
                                            >
                                              {player.name}
                                            </option>
                                          ))}
                                        </select>
                                        <button
                                          className="rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
                                          disabled={
                                            adminSaving ||
                                            tournamentIsClosed ||
                                            isFull ||
                                            availablePlayers.length === 0 ||
                                            !availablePlayers.some(
                                              ({ id }) =>
                                                id === podSelections[pod.id],
                                            )
                                          }
                                          type="submit"
                                        >
                                          Asignar {participantLabel}
                                        </button>
                                      </form>

                                      <div className="mt-4 border-t border-white/10 pt-4">
                                        {!isSupportedPodSize(
                                          selectedTournament.format,
                                          pod.playerIds.length,
                                        ) ? (
                                          <p className="text-sm text-slate-400">
                                            {selectedTournament.format ===
                                            'two-headed-giant'
                                              ? 'Asigna exactamente 2 parejas para registrar el resultado de esta mesa.'
                                              : 'Los pods necesitan 3 o 4 jugadores para registrar un resultado.'}
                                          </p>
                                        ) : editingPodResults.includes(
                                            pod.id,
                                          ) ? (
                                          <form
                                            className="space-y-3"
                                            onSubmit={(event) =>
                                              savePodResult(event, round.id, pod)
                                            }
                                          >
                                            <div>
                                              <h5 className="text-sm font-semibold text-slate-100">
                                                {pod.result
                                                  ? 'Editar resultado'
                                                  : 'Registrar resultado'}
                                              </h5>
                                              <p className="app-supporting-copy text-xs text-slate-400">
                                                {selectedTournament.format ===
                                                'two-headed-giant'
                                                  ? 'Marca Gana y Pierde para un resultado normal, o Empate para las dos parejas.'
                                                  : 'Asigna el mismo puesto a las personas empatadas. Tras un empate, el siguiente puesto avanza según el número de jugadores empatados.'}
                                              </p>
                                            </div>
                                            <ul className="space-y-2">
                                              {pod.playerIds.map(
                                                (playerId) => {
                                                  const player =
                                                    selectedTournament.players.find(
                                                      ({ id }) =>
                                                        id === playerId,
                                                    )
                                                  if (!player) {
                                                    return null
                                                  }

                                                  const resultSelectId = `result-${pod.id}-${player.id}`
                                                  return (
                                                    <li
                                                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                                                      key={player.id}
                                                    >
                                                      <label
                                                        className="min-w-0 truncate text-sm text-slate-200"
                                                        htmlFor={resultSelectId}
                                                      >
                                                        {player.name}
                                                      </label>
                                                      <select
                                                        className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                                                        id={resultSelectId}
                                                        onChange={(event) =>
                                                          setPodResultDrafts(
                                                            (current) => ({
                                                              ...current,
                                                              [pod.id]: {
                                                                ...current[
                                                                  pod.id
                                                                ],
                                                                [player.id]:
                                                                  event.target
                                                                    .value,
                                                              },
                                                            }),
                                                          )
                                                        }
                                                        required
                                                        value={
                                                          podResultDrafts[
                                                            pod.id
                                                          ]?.[player.id] ?? ''
                                                        }
                                                      >
                                                        <option value="">
                                                          {selectedTournament.format ===
                                                          'two-headed-giant'
                                                            ? 'Resultado'
                                                            : 'Puesto'}
                                                        </option>
                                                        {selectedTournament.format ===
                                                        'two-headed-giant' ? (
                                                          <>
                                                            <option
                                                              value="win"
                                                            >
                                                              Gana · 4 puntos
                                                            </option>
                                                            <option value="draw">
                                                              Empate · 2 puntos
                                                            </option>
                                                            <option value="loss">
                                                              Pierde · 0 puntos
                                                            </option>
                                                          </>
                                                        ) : (
                                                          pod.playerIds.map(
                                                            (_, placeIndex) => (
                                                              <option
                                                                key={placeIndex + 1}
                                                                value={
                                                                  placeIndex + 1
                                                                }
                                                              >
                                                                {placeIndex + 1}.º
                                                                puesto
                                                              </option>
                                                            ),
                                                          )
                                                        )}
                                                      </select>
                                                    </li>
                                                  )
                                                },
                                              )}
                                            </ul>
                                            {podResultErrors[pod.id] && (
                                              <p
                                                className="text-sm text-rose-300"
                                                role="alert"
                                              >
                                                {podResultErrors[pod.id]}
                                              </p>
                                            )}
                                            <div className="flex flex-wrap gap-2">
                                              <button
                                                className="rounded-lg bg-amber-300 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200"
                                                type="submit"
                                              >
                                                Guardar resultado
                                              </button>
                                              <button
                                                className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/10"
                                                onClick={() =>
                                                  cancelPodResultEdit(pod.id)
                                                }
                                                type="button"
                                              >
                                                Cancelar
                                              </button>
                                            </div>
                                          </form>
                                        ) : (
                                          <>
                                            {podResult ? (
                                              <div className="space-y-2">
                                                <h5 className="text-sm font-semibold text-emerald-200">
                                                  Resultado guardado
                                                </h5>
                                                <ol className="space-y-1">
                                                  {podResult.placements.map(
                                                    (
                                                      placement,
                                                      placementIndex,
                                                    ) => {
                                                      const place =
                                                        podResult.placements
                                                          .slice(
                                                            0,
                                                            placementIndex,
                                                          )
                                                          .reduce(
                                                            (total, previous) =>
                                                              total +
                                                              previous.length,
                                                            1,
                                                          )
                                                      const tiedPlayers =
                                                        placement
                                                          .map((playerId) =>
                                                            selectedTournament.players.find(
                                                              ({ id }) =>
                                                                id === playerId,
                                                            ),
                                                          )
                                                          .filter(
                                                            (player) =>
                                                              player !==
                                                              undefined,
                                                          )
                                                      return (
                                                        <li
                                                          className="text-sm text-slate-300"
                                                          key={placementIndex}
                                                        >
                                                          <span className="font-medium text-slate-100">
                                                            {selectedTournament.format ===
                                                            'two-headed-giant'
                                                              ? podResult.placements.length ===
                                                                1
                                                                ? 'Empate'
                                                                : placementIndex ===
                                                                  0
                                                                ? 'Victoria'
                                                                : 'Derrota'
                                                              : `${place}.º puesto`}
                                                          </span>
                                                          {' — '}
                                                          {tiedPlayers
                                                            .map(
                                                              ({ name }) =>
                                                                name,
                                                            )
                                                            .join(', ')}
                                                          {' · '}
                                                          {resultPoints.get(
                                                            placement[0],
                                                          )}{' '}
                                                          {resultPoints.get(
                                                            placement[0],
                                                          ) === 1
                                                            ? 'punto'
                                                            : 'puntos'}
                                                          {placement.length >
                                                            1 && ' cada uno'}
                                                        </li>
                                                      )
                                                    },
                                                  )}
                                                </ol>
                                              </div>
                                            ) : (
                                              <p className="text-sm text-slate-400">
                                                Aún no hay resultado registrado.
                                              </p>
                                            )}
                                            <button
                                              className="mt-3 rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
                                              disabled={adminSaving || tournamentIsClosed}
                                              onClick={() =>
                                                startEditingPodResult(pod)
                                              }
                                              type="button"
                                            >
                                              {podResult
                                                ? 'Editar resultado'
                                                : 'Registrar resultado'}
                                            </button>
                                          </>
                                        )}
                                      </div>
                                    </section>
                                  )
                                })}
                              </div>
                            )}

                            <aside
                              aria-label={`Jugadores sin asignar en la ronda ${roundIndex + 1}`}
                              className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-4 py-3"
                            >
                              <h4 className="text-sm font-semibold text-amber-100">
                                Sin asignar
                                <span className="ml-2 font-normal text-amber-100/70">
                                  ({unassignedPlayers.length})
                                </span>
                              </h4>
                              {unassignedPlayers.length > 0 ? (
                                <ul className="mt-2 flex flex-wrap gap-2">
                                  {unassignedPlayers.map((player) => (
                                    <li
                                      className="rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-200"
                                      key={player.id}
                                    >
                                      {player.name}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="app-supporting-copy text-sm text-slate-300">
                                  {selectedTournament.players.length === 0
                                    ? selectedTournament.format ===
                                      'two-headed-giant'
                                      ? 'Añade parejas al torneo para poder asignarlas.'
                                      : 'Añade jugadores al torneo para poder asignarlos.'
                                    : selectedTournament.format ===
                                      'two-headed-giant'
                                      ? 'Todas las parejas están asignadas en esta ronda.'
                                      : 'Todos los jugadores están asignados en esta ronda.'}
                                </p>
                              )}
                            </aside>
                            </div>
                          </section>
                        )
                      })}
                    </div>
                  )}
                </section>

                <Suspense
                 fallback={
                   <p
                     aria-live="polite"
                     className="mt-8 text-sm text-slate-300"
                     role="status"
                   >
                     Cargando propuestas de resultado…
                   </p>
                 }
                >
                 <TournamentResultProposals
                   closed={tournamentIsClosed}
                   key={selectedTournament.id}
                   onPendingCountChange={reportPendingProposalCount}
                   onApproved={applyApprovedProposal}
                   summaryRoundId={controlRound?.id ?? null}
                   saving={adminSaving}
                   tournament={selectedTournament}
                 />
                </Suspense>

                <section
                  aria-labelledby="standings-heading"
                  className="mt-8 border-t border-white/10 pt-6"
                >
                  <p className="app-kicker text-sm font-semibold text-amber-300">
                    Resultados acumulados
                  </p>
                  <h2 className="mb-4 scroll-mt-24" id="standings-heading">
                    {selectedTournament.format === 'two-headed-giant'
                      ? 'Clasificación de parejas'
                      : 'Clasificación'}
                  </h2>
                  {standings.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-700 px-4 py-5 text-sm text-slate-400">
                      Añade {participantsLabel} para crear la clasificación del
                      torneo.
                    </p>
                  ) : (
                    <ol
                      aria-label="Clasificación del torneo"
                      className="divide-y divide-white/10 rounded-xl border border-white/10"
                    >
                      {standings.map((standing) => (
                        <li
                          className="flex items-center justify-between gap-4 px-4 py-3"
                          key={standing.id}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              aria-label={`${standing.position}.º puesto`}
                              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-amber-200"
                            >
                              {standing.position}
                            </span>
                            <span className="truncate font-medium text-slate-100">
                              {standing.name}
                            </span>
                          </div>
                          <span className="shrink-0 text-sm font-semibold text-amber-200">
                            {standing.points}{' '}
                            {standing.points === 1 ? 'punto' : 'puntos'}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="app-supporting-copy text-xs text-slate-500">
                    Los empates en puntos comparten puesto; no se aplican
                    desempates.
                  </p>
                </section>
              </>
            ) : (
              <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 px-6 py-12 text-center">
                <span
                  aria-hidden="true"
                  className="mb-4 flex size-12 items-center justify-center rounded-full bg-amber-300/10 text-2xl text-amber-300"
                >
                  +
                </span>
                <h2 id="players-heading">Tu mesa empieza aquí</h2>
                <p className="app-supporting-copy max-w-sm text-sm text-slate-400">
                  Crea un torneo o selecciona uno de tu lista para gestionar
                  sus participantes.
                </p>
              </div>
            )}
          </section>
        </div>

        {!adminMode && adminAccess && (
          <AdminPanel
            onOpenTournament={setAdminEditingRecord}
          />
        )}
        {!adminMode && adminAccessError && (
          <p
            className="mt-6 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
            role="alert"
          >
            No se habilitó el panel de administración: {adminAccessError}
          </p>
        )}

        <footer className="mt-8 text-center text-xs text-slate-500">
          {adminMode
            ? 'Los cambios de este torneo se guardan en Supabase y conservan a su propietario.'
            : 'Los torneos, participantes y rondas se guardan en este dispositivo.'}
        </footer>
      </div>
    </main>
  )
}

function AuthenticatedApp() {
  const [authState, setAuthState] = useState<AuthState>(() => {
    try {
      return {
        status: 'loading',
        session: null,
        client: getSupabaseClient(),
        error: '',
      }
    } catch {
      return {
        status: 'error',
        session: null,
        client: null,
        error:
          'La autenticación no está configurada. Revisa VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY.',
      }
    }
  })
  const [workspace, setWorkspace] = useState<{
    userId: string
    tournaments: Tournament[]
  } | null>(null)
  const recoveryLinkRequested = useRef(
    new URLSearchParams(window.location.search).get('password-recovery') ===
      '1' ||
      new URLSearchParams(window.location.hash.slice(1)).get('type') ===
        'recovery',
  )
  const passwordRecoveryActive = useRef(false)
  const client = authState.client

  useEffect(() => {
    let active = true
    let authEventReceived = false
    if (!client) {
      return
    }

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => {
      if (
        event === 'INITIAL_SESSION' &&
        recoveryLinkRequested.current &&
        !session
      ) {
        return
      }
      authEventReceived = true
      if (active) {
        if (
          event === 'PASSWORD_RECOVERY' ||
          (recoveryLinkRequested.current && session)
        ) {
          passwordRecoveryActive.current = true
        }

        if (event === 'SIGNED_OUT') {
          passwordRecoveryActive.current = false
        }

        if (passwordRecoveryActive.current) {
          if (session) {
            setWorkspace(null)
            setAuthState({
              status: 'password-recovery',
              session,
              client,
              error: '',
            })
          } else {
            setWorkspace(null)
            setAuthState({
              status: 'signed-out',
              session: null,
              client,
              error:
                'El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo desde la pantalla de acceso.',
            })
          }
          return
        }

        setWorkspace(
          session
            ? {
                userId: session.user.id,
                tournaments: migrateLegacyTournaments(session.user.id),
              }
            : null,
        )
        setAuthState({
          status: session ? 'signed-in' : 'signed-out',
          session,
          client,
          error:
            !session && recoveryLinkRequested.current
              ? 'El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo desde la pantalla de acceso.'
              : '',
        })
      }
    })

    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active || authEventReceived) {
          return
        }

        setWorkspace(
          !error && data.session
            ? {
                userId: data.session.user.id,
                tournaments: migrateLegacyTournaments(data.session.user.id),
              }
            : null,
        )
        setAuthState({
          status: error
            ? 'error'
            : data.session
              ? recoveryLinkRequested.current
                ? 'password-recovery'
                : 'signed-in'
              : 'signed-out',
          session: error ? null : data.session,
          client,
          error: error
            ? getAuthErrorMessage(error)
            : !data.session && recoveryLinkRequested.current
              ? 'El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo desde la pantalla de acceso.'
              : '',
        })
        if (data.session && recoveryLinkRequested.current) {
          passwordRecoveryActive.current = true
        }
      })
      .catch((error: unknown) => {
        if (active && !authEventReceived) {
          setWorkspace(null)
          setAuthState({
            status: 'error',
            session: null,
            client,
            error: getAuthErrorMessage(error),
          })
        }
      })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [client])

  const userId =
    authState.status === 'signed-in' ? authState.session?.user.id : undefined

  function continueAfterPasswordRecovery() {
    const session = authState.session
    if (!session || !client) {
      return
    }

    passwordRecoveryActive.current = false
    recoveryLinkRequested.current = false
    clearPasswordRecoveryRedirect()
    setWorkspace({
      userId: session.user.id,
      tournaments: migrateLegacyTournaments(session.user.id),
    })
    setAuthState({
      status: 'signed-in',
      session,
      client,
      error: '',
    })
  }

  if (authState.status === 'loading') {
    return (
      <main
        aria-live="polite"
        className="app-shell flex min-h-screen items-center justify-center px-4"
        role="status"
      >
        <p className="text-slate-200">Comprobando tu sesión…</p>
      </main>
    )
  }

  if (authState.status === 'password-recovery' && client) {
    return (
      <AuthScreen
        client={client}
        initialError={authState.error}
        initialMode="update-password"
        onRecoveryComplete={continueAfterPasswordRecovery}
      />
    )
  }

  if (userId && client) {
    if (!workspace || workspace.userId !== userId) {
      return (
        <main
          aria-live="polite"
          className="app-shell flex min-h-screen items-center justify-center px-4"
          role="status"
        >
          <p className="text-slate-200">Cargando tus torneos…</p>
        </main>
      )
    }

    return (
      <TournamentWorkspace
        initialTournaments={workspace.tournaments}
        initialAutoSyncEnabled={
          authState.session?.user.user_metadata[
            'commander_tournament_auto_sync'
          ] === true
        }
        key={userId}
        onSignOut={async () => {
          const { error } = await client.auth.signOut()
          if (error) {
            throw error
          }
        }}
        userId={userId}
      />
    )
  }

  return (
    <AuthScreen client={authState.client} initialError={authState.error} />
  )
}

function App() {
  const publicToken = new URLSearchParams(window.location.search).get('public')
  if (publicToken !== null) {
    return (
      <Suspense
        fallback={
          <main
            aria-live="polite"
            className="app-shell flex min-h-screen items-center justify-center px-4"
            role="status"
          >
            <p className="text-slate-200">Cargando tablero público…</p>
          </main>
        }
      >
        <PublicTournamentScreen token={publicToken} />
      </Suspense>
    )
  }
  return <AuthenticatedApp />
}

export default App
