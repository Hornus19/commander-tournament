import { useRegisterSW } from 'virtual:pwa-register/react'

function PwaNotifications() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh && !offlineReady) {
    return null
  }

  return (
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-lg flex-col gap-3">
      {needRefresh && (
        <section
          aria-atomic="true"
          aria-live="polite"
          className="flex items-center justify-between gap-4 rounded-lg border border-violet-300 bg-white p-4 text-slate-900 shadow-lg"
          role="status"
        >
          <p>Hay una actualización disponible.</p>
          <div className="flex shrink-0 gap-2">
            <button
              className="rounded bg-violet-700 px-3 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
              onClick={() => void updateServiceWorker(true)}
              type="button"
            >
              Actualizar
            </button>
            <button
              aria-label="Descartar aviso de actualización"
              className="rounded px-2 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
              onClick={() => setNeedRefresh(false)}
              type="button"
            >
              Cerrar
            </button>
          </div>
        </section>
      )}
      {offlineReady && (
        <section
          aria-atomic="true"
          aria-live="polite"
          className="flex items-center justify-between gap-4 rounded-lg border border-emerald-300 bg-white p-4 text-slate-900 shadow-lg"
          role="status"
        >
          <p>La aplicación está lista para usar sin conexión.</p>
          <button
            aria-label="Descartar aviso de disponibilidad sin conexión"
            className="shrink-0 rounded px-2 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            onClick={() => setOfflineReady(false)}
            type="button"
          >
            Cerrar
          </button>
        </section>
      )}
    </div>
  )
}

export default PwaNotifications
