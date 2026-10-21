import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { CompareEntry, CompareResult, FilePair, ServerProfile } from '../../../shared/types'
import DiffView from './DiffView'
import RemotePathBrowser from './RemotePathBrowser'

interface CompareViewProps {
  profile: ServerProfile
}

const STATUS_LABEL: Record<CompareEntry['status'], string> = {
  'local-only': 'solo local',
  'remote-only': 'solo servidor',
  modified: 'distinto',
  identical: 'igual',
  'same-size': 'mismo tamaño'
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function CompareView({ profile }: CompareViewProps): JSX.Element {
  const [localPath, setLocalPath] = useState(profile.localRoot ?? '')
  const [remotePath, setRemotePath] = useState(profile.remoteRoot ?? '/')
  const [result, setResult] = useState<CompareResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [onlyChanges, setOnlyChanges] = useState(true)
  const [activeRel, setActiveRel] = useState<string | null>(null)
  const [pair, setPair] = useState<FilePair | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)

  useEffect(() => {
    setLocalPath(profile.localRoot ?? '')
    setRemotePath(profile.remoteRoot ?? '/')
    setResult(null)
    setPair(null)
    setActiveRel(null)
    setError(null)
    setToast(null)
  }, [profile.id, profile.localRoot, profile.remoteRoot])

  const visibleEntries = useMemo(() => {
    if (!result) return []
    if (!onlyChanges) return result.entries
    return result.entries.filter((entry) => entry.status !== 'identical')
  }, [result, onlyChanges])

  const runCompare = async (): Promise<void> => {
    setError(null)
    setToast(null)
    if (!localPath.trim()) {
      setError('Selecciona un directorio local.')
      return
    }
    setBusy(true)
    try {
      const compared = await window.api.compare.run(profile.id, remotePath, localPath)
      setResult(compared)
      setPair(null)
      setActiveRel(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo comparar.')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const openFile = async (entry: CompareEntry): Promise<void> => {
    setError(null)
    setToast(null)
    if (entry.status === 'remote-only') {
      setActiveRel(entry.relPath)
      setPair(null)
      setError('El archivo solo existe en el servidor; no hay versión local para comparar.')
      return
    }
    setActiveRel(entry.relPath)
    setPairLoading(true)
    try {
      const loaded = await window.api.files.readPair(profile.id, remotePath, localPath, entry.relPath)
      setPair(loaded)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo leer el archivo.')
      setPair(null)
    } finally {
      setPairLoading(false)
    }
  }

  const uploaded = (message: string): void => {
    setToast(message)
    void (async () => {
      try {
        const compared = await window.api.compare.run(profile.id, remotePath, localPath)
        setResult(compared)
        const refreshed = await window.api.files.readPair(profile.id, remotePath, localPath, activeRel ?? '')
        setPair(refreshed)
      } catch {
        /* la comparación se puede repetir manualmente */
      }
    })()
  }

  return (
    <div className="compare">
      <div className="compare-toolbar">
        <label className="field">
          <span>Directorio local</span>
          <div className="input-row">
            <input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="C:\proyectos\app"
            />
            <button
              type="button"
              className="ghost small"
              onClick={async () => {
                const picked = await window.api.local.pickDirectory()
                if (picked) setLocalPath(picked)
              }}
            >
              Elegir…
            </button>
          </div>
        </label>
        <label className="field">
          <span>Directorio en el servidor</span>
          <div className="input-row">
            <input
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="/var/www/app"
            />
            <button type="button" className="ghost small" onClick={() => setBrowserOpen(true)}>
              Explorar…
            </button>
          </div>
        </label>
        <button type="button" className="primary" onClick={() => void runCompare()} disabled={busy}>
          {busy ? 'Comparando…' : 'Comparar'}
        </button>
        <label className="checkbox small">
          <input
            type="checkbox"
            checked={onlyChanges}
            onChange={(e) => setOnlyChanges(e.target.checked)}
          />
          Solo diferencias
        </label>
      </div>

      {error ? <p className="error-banner">{error}</p> : null}
      {toast ? <p className="ok-banner">{toast}</p> : null}

      <div className="compare-body">
        <div className="file-list">
          <div className="file-list-head">
            <span>{result ? `${visibleEntries.length} archivo(s)` : 'Sin comparar'}</span>
            {result?.truncated ? <span className="warn">truncado</span> : null}
          </div>
          <ul>
            {visibleEntries.map((entry) => (
              <li key={entry.relPath}>
                <button
                  type="button"
                  className={`file-row ${activeRel === entry.relPath ? 'active' : ''}`}
                  onClick={() => void openFile(entry)}
                  title={`${entry.relPath} · local ${formatSize(entry.localSize)} · servidor ${formatSize(entry.remoteSize)}`}
                >
                  <span className={`status-chip ${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
                  <span className="file-path">{entry.relPath}</span>
                </button>
              </li>
            ))}
            {result && visibleEntries.length === 0 ? (
              <li className="empty-hint">No hay diferencias.</li>
            ) : null}
            {!result ? (
              <li className="empty-hint">Elige las carpetas y pulsa Comparar.</li>
            ) : null}
          </ul>
        </div>

        <div className="diff-area">
          {pairLoading ? <p className="empty-hint">Cargando archivo…</p> : null}
          {!pairLoading && pair ? (
            <DiffView
              key={`${pair.remotePath}::${pair.remoteHash}`}
              serverId={profile.id}
              pair={pair}
              onUploaded={uploaded}
            />
          ) : null}
          {!pairLoading && !pair ? (
            <p className="empty-hint">Selecciona un archivo de la lista para ver los cambios.</p>
          ) : null}
        </div>
      </div>

      {browserOpen ? (
        <RemotePathBrowser
          serverId={profile.id}
          initialPath={remotePath}
          onClose={() => setBrowserOpen(false)}
          onPick={(picked) => {
            setRemotePath(picked)
            setBrowserOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}
