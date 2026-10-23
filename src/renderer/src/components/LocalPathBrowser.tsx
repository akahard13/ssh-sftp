import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { LocalEntry } from '../../../shared/types'
import { api } from '../lib/api'
import Modal from './Modal'

interface LocalPathBrowserProps {
  initialPath: string
  /** 'directory' elige la carpeta actual; 'file' exige seleccionar un archivo. */
  mode: 'directory' | 'file'
  title?: string
  onPick: (path: string) => void
  onClose: () => void
}

/**
 * Explorador del disco del equipo que ejecuta la app. En el modo servidor
 * sustituye a los diálogos nativos, que solo existen dentro de Electron.
 */
export default function LocalPathBrowser({
  initialPath,
  mode,
  title,
  onPick,
  onClose
}: LocalPathBrowserProps): JSX.Element {
  const [path, setPath] = useState(initialPath)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<LocalEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (target: string | null) => {
    setLoading(true)
    setError(null)
    setSelected(null)
    try {
      const listing = await api.local.listDirectories(target && target.trim() ? target.trim() : null)
      setPath(listing.path)
      setParent(listing.parent)
      setEntries(listing.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo leer el directorio.')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(initialPath)
    // Solo la ruta inicial; recargar al cambiar de padre lo controla cada acción.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const choose = (): void => {
    if (mode === 'file') {
      if (selected) onPick(selected)
      return
    }
    onPick(path)
  }

  return (
    <Modal
      title={title ?? (mode === 'file' ? 'Elegir archivo' : 'Elegir carpeta')}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary"
            onClick={choose}
            disabled={mode === 'file' && !selected}
          >
            {mode === 'file' ? 'Usar este archivo' : 'Usar esta carpeta'}
          </button>
        </>
      }
    >
      <div className="path-bar">
        <button
          type="button"
          className="ghost small"
          onClick={() => void load(parent)}
          disabled={!parent || loading}
        >
          ↑ Subir
        </button>
        <input
          className="path-current"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(path)
          }}
          aria-label="Ruta"
        />
        <button type="button" className="ghost small" onClick={() => void load(path)} disabled={loading}>
          Ir
        </button>
      </div>
      {error ? <p className="error-banner">{error}</p> : null}
      <ul className="dir-list">
        {loading ? <li className="empty-hint">Cargando…</li> : null}
        {!loading && entries.length === 0 && !error ? (
          <li className="empty-hint">Sin subdirectorios.</li>
        ) : null}
        {entries.map((entry) => {
          const isSelected = mode === 'file' && !entry.isDirectory && selected === entry.path
          if (entry.isDirectory) {
            return (
              <li key={entry.path}>
                <button type="button" className="dir-row" onClick={() => void load(entry.path)}>
                  📁 {entry.name}
                </button>
              </li>
            )
          }
          if (mode === 'directory') {
            return (
              <li key={entry.path} className="dir-row muted" aria-disabled="true">
                📄 {entry.name}
              </li>
            )
          }
          return (
            <li key={entry.path}>
              <button
                type="button"
                className={'dir-row' + (isSelected ? ' selected' : '')}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => onPick(entry.path)}
              >
                📄 {entry.name}
              </button>
            </li>
          )
        })}
      </ul>
    </Modal>
  )
}
