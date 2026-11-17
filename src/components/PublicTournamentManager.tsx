import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  createPublicTournamentLink,
  getPublicTournamentLink,
  revokePublicTournamentLink,
} from '../lib/publicTournamentRepository'

const PUBLIC_APP_URL =
  import.meta.env.VITE_PUBLIC_APP_URL?.trim() ||
  'https://commander-tournament.pages.dev'

function getPublicTournamentUrl(token: string) {
  const url = new URL(PUBLIC_APP_URL)
  url.pathname = '/'
  url.search = ''
  url.searchParams.set('public', token)
  url.hash = ''
  return url.toString()
}

export default function PublicTournamentManager({
  tournamentId,
  adminSaving,
}: {
  tournamentId: string
  adminSaving: boolean
}) {
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [qrVisible, setQrVisible] = useState(false)
  const url = token ? getPublicTournamentUrl(token) : ''

  useEffect(() => {
    let active = true
    void getPublicTournamentLink(tournamentId)
      .then((currentToken) => {
        if (active) {
          setToken(currentToken)
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'No se pudo consultar el enlace público del torneo.',
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
  }, [tournamentId])

  async function createLink() {
    if (busy || loading || adminSaving) {
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      setToken(await createPublicTournamentLink(tournamentId))
      setQrVisible(false)
      setNotice('Enlace público creado.')
    } catch (createError: unknown) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'No se pudo crear el enlace público del torneo.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function copyLink() {
    if (!token) {
      return
    }

    setError('')
    setNotice('')
    try {
      await navigator.clipboard.writeText(url)
      setNotice('Enlace copiado al portapapeles.')
    } catch {
      setError(
        'No se pudo copiar el enlace. Comprueba los permisos del portapapeles e inténtalo de nuevo.',
      )
    }
  }

  async function revokeLink() {
    if (
      !token ||
      busy ||
      !window.confirm(
        'Al revocar el enlace, quienes lo tengan dejarán de ver el tablero público. ¿Quieres continuar?',
      )
    ) {
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      const revoked = await revokePublicTournamentLink(tournamentId)
      setToken(null)
      setQrVisible(false)
      setNotice(
        revoked
          ? 'Enlace público revocado.'
          : 'El enlace público ya no estaba activo.',
      )
    } catch (revokeError: unknown) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : 'No se pudo revocar el enlace público del torneo.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="public-link-heading"
      className="mb-6 rounded-xl border border-slate-700 bg-slate-950/40 p-4"
    >
      <h3
        className="text-base font-semibold text-slate-100"
        id="public-link-heading"
      >
        Tablero público y QR
      </h3>
      <p className="app-supporting-copy mt-1 text-sm text-slate-400">
        El enlace solo muestra la ronda elegida y los nombres de sus jugadores.
        Guarda primero el torneo en Supabase; el tablero refleja los cambios
        sincronizados.
      </p>
      {error && (
        <p
          className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
          role="alert"
        >
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 text-sm text-emerald-200" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p
          aria-live="polite"
          className="mt-3 text-sm text-slate-300"
          role="status"
        >
          Consultando enlace público…
        </p>
      ) : token ? (
        <div className="mt-4 space-y-3">
          <a
            className="block break-all text-sm text-amber-200 underline underline-offset-4"
            href={url}
            rel="noopener noreferrer"
            target="_blank"
          >
            {url}
          </a>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-wait disabled:opacity-50"
              disabled={busy}
              onClick={() => void copyLink()}
              type="button"
            >
              Copiar enlace
            </button>
            <button
              aria-expanded={qrVisible}
              className="rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-300/10"
              onClick={() => setQrVisible((visible) => !visible)}
              type="button"
            >
              {qrVisible ? 'Ocultar QR' : 'Mostrar QR'}
            </button>
            <button
              className="rounded-lg border border-rose-400/40 px-3 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-400/10 disabled:cursor-wait disabled:opacity-50"
              disabled={busy}
              onClick={() => void revokeLink()}
              type="button"
            >
              {busy ? 'Guardando…' : 'Revocar enlace'}
            </button>
          </div>
          {qrVisible && (
            <div className="inline-flex rounded-lg bg-white p-3">
              <QRCodeSVG
                aria-label="Código QR del tablero público"
                bgColor="#ffffff"
                fgColor="#0f172a"
                size={208}
                title="Código QR del tablero público"
                value={url}
              />
            </div>
          )}
        </div>
      ) : (
        <button
          className="mt-4 rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-wait disabled:opacity-50"
          disabled={busy || adminSaving}
          onClick={() => void createLink()}
          type="button"
        >
          {busy ? 'Creando enlace…' : 'Crear enlace público'}
        </button>
      )}
    </section>
  )
}
