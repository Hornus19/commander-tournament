import { useEffect, useState } from 'react'

type RoundCountdownProps = {
  roundId: string
  roundNumber: number
  startedAt: string | null | undefined
  hasMissingResults: boolean
  onDeadline: (roundId: string) => Promise<boolean>
}

function formatRemainingTime(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getNoticeStorageKey(roundId: string) {
  return `commander-tournament:round-deadline-notice:${roundId}`
}

export default function RoundCountdown({
  roundId,
  roundNumber,
  startedAt,
  hasMissingResults,
  onDeadline,
}: RoundCountdownProps) {
  const [now, setNow] = useState(() => Date.now())
  const [showNotice, setShowNotice] = useState(false)

  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN
  const deadline = startedAtMs + 60 * 60 * 1000

  useEffect(() => {
    if (!Number.isFinite(startedAtMs)) {
      return
    }

    let active = true
    let deadlineChecked = false
    let nextCheckAt = deadline
    const noticeStorageKey = getNoticeStorageKey(roundId)

    try {
      if (window.localStorage.getItem(noticeStorageKey) === 'dismissed') {
        deadlineChecked = true
      }
      setShowNotice(
        hasMissingResults &&
          window.localStorage.getItem(noticeStorageKey) === 'shown',
      )
    } catch {
      setShowNotice(false)
    }

    async function checkDeadline(currentTime: number) {
      if (
        deadlineChecked ||
        currentTime < deadline ||
        currentTime < nextCheckAt
      ) {
        return
      }
      deadlineChecked = true

      try {
        const hasMissingResults = await onDeadline(roundId)
        if (!active || !hasMissingResults) {
          return
        }
        setShowNotice(true)
        try {
          window.localStorage.setItem(noticeStorageKey, 'shown')
        } catch {
          // Keep the in-page notice even if browser storage is unavailable.
        }
      } catch {
        deadlineChecked = false
        nextCheckAt = Date.now() + 10_000
      }
    }

    function updateClock() {
      const currentTime = Date.now()
      setNow(currentTime)
      void checkDeadline(currentTime)
    }

    setNow(Date.now())
    const intervalId = window.setInterval(updateClock, 1000)
    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [deadline, hasMissingResults, onDeadline, roundId, startedAtMs])

  useEffect(() => {
    if (hasMissingResults) {
      return
    }
    setShowNotice(false)
    try {
      window.localStorage.removeItem(getNoticeStorageKey(roundId))
    } catch {
      // The notice can still be dismissed in memory if storage is unavailable.
    }
  }, [hasMissingResults, roundId])

  if (!Number.isFinite(startedAtMs)) {
    return null
  }

  const remainingMs = Math.max(0, deadline - now)
  const hasEnded = remainingMs === 0

  return (
    <div className="mt-5 space-y-3">
      <div
        aria-label={`Tiempo restante de la ronda ${roundNumber}: ${formatRemainingTime(remainingMs)}`}
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${
          hasEnded
            ? 'border-rose-300/30 bg-rose-300/10'
            : 'border-amber-300/25 bg-amber-300/5'
        }`}
      >
        <span className="text-sm font-medium text-slate-200">
          {hasEnded
            ? `Tiempo de la ronda ${roundNumber} agotado`
            : `Tiempo restante · Ronda ${roundNumber}`}
        </span>
        <span
          aria-live="off"
          className={`font-mono text-xl font-bold tabular-nums ${
            hasEnded ? 'text-rose-200' : 'text-amber-200'
          }`}
        >
          {formatRemainingTime(remainingMs)}
        </span>
      </div>
      {showNotice && (
        <div
          className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-3xl items-start justify-between gap-4 rounded-xl border border-rose-300/35 bg-slate-950 px-4 py-3 text-sm text-rose-100 shadow-xl shadow-black/40"
          role="alert"
        >
          <span>
            Ha terminado la hora de la ronda {roundNumber}. Quedan resultados
            por enviar.
          </span>
          <button
            aria-label="Cerrar aviso de fin de ronda"
            className="shrink-0 rounded px-2 text-lg leading-5 text-rose-100 hover:bg-white/10"
            onClick={() => {
              setShowNotice(false)
              try {
                window.localStorage.setItem(
                  getNoticeStorageKey(roundId),
                  'dismissed',
                )
              } catch {
                // The notice can still be dismissed in memory if storage is unavailable.
              }
            }}
            type="button"
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
