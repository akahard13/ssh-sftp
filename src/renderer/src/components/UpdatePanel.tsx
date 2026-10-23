import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UpdateState } from '../../../shared/types'
import { api } from '../lib/api'

export default function UpdatePanel(): JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.updates.state().then(setState)
    return api.updates.onState(setState)
  }, [])

  const status = state?.status ?? 'idle'
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="update-panel">
      <div className="update-head">
        <span className="update-version">v{state?.currentVersion ?? '…'}</span>
        {api.platform === 'web' ? (
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              void fetch('/api/logout', { method: 'POST' }).finally(() => {
                window.location.assign('/login')
              })
            }}
          >
            Cerrar sesión
          </button>
        ) : null}
        {(status === 'idle' || status === 'none' || status === 'error' || status === 'unsupported') && (
          <button
            type="button"
            className="ghost small"
            disabled={busy || status === 'unsupported'}
            onClick={() => void run(() => api.updates.check())}
          >
            Buscar actualizaciones
          </button>
        )}
        {status === 'checking' ? <span className="update-message">Buscando…</span> : null}
      </div>

      {status === 'available' ? (
        <div className="update-body">
          <p className="update-message">Versión {state?.version} disponible.</p>
          <button
            type="button"
            className="primary small"
            disabled={busy}
            onClick={() => void run(() => api.updates.download())}
          >
            Descargar
          </button>
        </div>
      ) : null}

      {status === 'downloading' ? (
        <div className="update-body">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${state?.percent ?? 0}%` }} />
          </div>
          <span className="update-message">Descargando {state?.percent ?? 0}%</span>
        </div>
      ) : null}

      {status === 'ready' ? (
        <div className="update-body">
          <p className="update-message">
            Versión {state?.version} lista. {state?.message}
          </p>
          <button
            type="button"
            className="primary small"
            onClick={() => void api.updates.install()}
          >
            Reiniciar e instalar
          </button>
        </div>
      ) : null}

      {status === 'none' ? <p className="update-message">{state?.message}</p> : null}
      {status === 'error' ? <p className="update-error">{state?.message}</p> : null}
      {status === 'unsupported' ? <p className="update-message">{state?.message}</p> : null}
    </div>
  )
}
