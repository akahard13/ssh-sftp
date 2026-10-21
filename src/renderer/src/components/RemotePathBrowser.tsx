import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { RemoteDir } from '../../../shared/types'
import Modal from './Modal'

interface RemotePathBrowserProps {
  serverId: string
  initialPath: string
  onPick: (path: string) => void
  onClose: () => void
}

export default function RemotePathBrowser({
  serverId,
  initialPath,
  onPick,
  onClose
}: RemotePathBrowserProps): JSX.Element {
  const [path, setPath] = useState(initialPath.startsWith('/') ? initialPath : '/')
  const [entries, setEntries] = useState<RemoteDir[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (target: string) => {
      setLoading(true)
      setError(null)
      try {
        const list = await window.api.remote.listDirectories(serverId, target)
        setEntries(list)
        setPath(target)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo leer el directorio.')
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [serverId]
  )

  useEffect(() => {
    void load(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const parent = (): string => {
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    return `/${parts.join('/')}`
  }

  return (
    <Modal
      title="Elegir carpeta en el servidor"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="primary" onClick={() => onPick(path)}>
            Usar esta carpeta
          </button>
        </>
      }
    >
      <div className="path-bar">
        <button type="button" className="ghost small" onClick={() => void load(parent())} disabled={path === '/'}>
          ↑ Subir
        </button>
        <code className="path-current">{path}</code>
        <button type="button" className="ghost small" onClick={() => void load(path)} disabled={loading}>
          Recargar
        </button>
      </div>
      {error ? <p className="error-banner">{error}</p> : null}
      <ul className="dir-list">
        {loading ? <li className="empty-hint">Cargando…</li> : null}
        {!loading && entries.length === 0 && !error ? (
          <li className="empty-hint">Sin subdirectorios.</li>
        ) : null}
        {entries.map((entry) => (
          <li key={entry.path}>
            <button type="button" className="dir-row" onClick={() => void load(entry.path)}>
              📁 {entry.name}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
