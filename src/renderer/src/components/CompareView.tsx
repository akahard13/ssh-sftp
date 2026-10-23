import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type {
  CompareEntry,
  CompareProgress,
  CompareResult,
  FilePair,
  ServerProfile
} from '../../../shared/types'
import DiffView from './DiffView'
import FileTree from './FileTree'
import LocalPathBrowser from './LocalPathBrowser'
import RemotePathBrowser from './RemotePathBrowser'
import { api } from '../lib/api'
import { buildTree, collectDirPaths } from '../lib/tree'

const LIST_MIN_WIDTH = 140
const LIST_MAX_RATIO = 0.6
const LIST_DEFAULT_WIDTH = 300

interface CompareViewProps {
  profile: ServerProfile
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `req-${Math.random().toString(36).slice(2)}`
}

function progressLabel(progress: CompareProgress | null): string {
  if (!progress) return 'Iniciando…'
  const phase = progress.phase === 'walking-remote' ? 'Listando el servidor' : 'Listando el local'
  return `${phase}: ${progress.dirs.toLocaleString('es')} carpetas · ${progress.entries.toLocaleString('es')} archivos`
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
  const [localBrowserOpen, setLocalBrowserOpen] = useState(false)
  const [progress, setProgress] = useState<CompareProgress | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [excludeText, setExcludeText] = useState('')
  const [excludeOpen, setExcludeOpen] = useState(false)
  const [listWidth, setListWidth] = useState(LIST_DEFAULT_WIDTH)
  const [listHidden, setListHidden] = useState(false)
  const activeRequest = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const listDrag = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    return api.compare.onProgress((incoming) => {
      if (incoming.requestId === activeRequest.current) setProgress(incoming)
    })
  }, [])

  useEffect(() => {
    void api.compare.defaults().then(({ defaults, saved }) => {
      setExcludeText((saved ?? defaults).join(', '))
    })
  }, [])

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

  const tree = useMemo(() => buildTree(visibleEntries), [visibleEntries])

  const toggleDir = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const maxListWidth = (): number => {
    const width = bodyRef.current?.getBoundingClientRect().width ?? 0
    return width === 0 ? LIST_MIN_WIDTH : Math.max(LIST_MIN_WIDTH, width * LIST_MAX_RATIO)
  }

  const beginListDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    listDrag.current = { startX: event.clientX, startWidth: listWidth }
  }

  const moveListDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = listDrag.current
    if (!drag) return
    const next = drag.startWidth + event.clientX - drag.startX
    setListWidth(clamp(next, LIST_MIN_WIDTH, maxListWidth()))
  }

  const endListDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!listDrag.current) return
    listDrag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const nudgeList = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    const direction = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    if (direction === 0) return
    event.preventDefault()
    setListWidth((current) => clamp(current + direction, LIST_MIN_WIDTH, maxListWidth()))
  }

  const excludeList = useMemo(
    () =>
      excludeText
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    [excludeText]
  )

  const runCompareRequest = async (): Promise<CompareResult | null> => {
    const requestId = newRequestId()
    activeRequest.current = requestId
    setProgress(null)
    void api.compare.saveExcludes(excludeList).catch(() => {
      /* se reintenta en la próxima comparación */
    })
    try {
      return await api.compare.run(
        requestId,
        profile.id,
        remotePath,
        localPath,
        excludeList
      )
    } finally {
      activeRequest.current = null
      setProgress(null)
    }
  }

  const runCompare = async (): Promise<void> => {
    setError(null)
    setToast(null)
    if (!localPath.trim()) {
      setError('Selecciona un directorio local.')
      return
    }
    setBusy(true)
    try {
      const compared = await runCompareRequest()
      if (!compared) {
        setToast('Comparación cancelada.')
        return
      }
      setResult(compared)
      setPair(null)
      setActiveRel(null)
      setExpanded(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo comparar.')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const cancelCompare = (): void => {
    const requestId = activeRequest.current
    if (requestId) void api.compare.cancel(requestId).catch(() => {})
  }

  const openFile = async (entry: CompareEntry): Promise<void> => {
    setError(null)
    setToast(null)
    setActiveRel(entry.relPath)
    setPairLoading(true)
    try {
      const loaded = await api.files.readPair(profile.id, remotePath, localPath, entry.relPath)
      setPair(loaded)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo leer el archivo.')
      setPair(null)
    } finally {
      setPairLoading(false)
    }
  }

  const refreshed = (message: string): void => {
    setToast(message)
    void (async () => {
      try {
        const compared = await runCompareRequest()
        if (!compared) return
        setResult(compared)
        const refreshed = await api.files.readPair(
          profile.id,
          remotePath,
          localPath,
          activeRel ?? ''
        )
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
          <span>
            Directorio local
            {api.platform === 'web' ? <span className="muted"> (en el host del servicio)</span> : null}
          </span>
          <div className="input-row">
            <input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder={api.platform === 'web' ? '/home/usuario/proyecto' : 'C:\\proyectos\\app'}
            />
            <button
              type="button"
              className="ghost small"
              onClick={async () => {
                if (api.platform === 'web') {
                  setLocalBrowserOpen(true)
                  return
                }
                const picked = await api.local.pickDirectory()
                if (picked) setLocalPath(picked)
              }}
            >
              {api.platform === 'web' ? 'Explorar…' : 'Elegir…'}
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
        {busy ? (
          <>
            <button type="button" className="ghost" onClick={cancelCompare}>
              Cancelar
            </button>
            <span className="update-message">{progressLabel(progress)}</span>
          </>
        ) : (
          <button type="button" className="primary" onClick={() => void runCompare()}>
            Comparar
          </button>
        )}
        <label className="checkbox small">
          <input
            type="checkbox"
            checked={onlyChanges}
            onChange={(e) => setOnlyChanges(e.target.checked)}
          />
          Solo diferencias
        </label>
        <button type="button" className="ghost small" onClick={() => setExcludeOpen((open) => !open)}>
          {excludeOpen ? 'Ocultar exclusiones' : `Exclusiones (${excludeList.length})`}
        </button>
        {excludeOpen ? (
          <label className="field field-wide">
            <span>Ignorar carpetas y archivos (separados por coma; acepta * como comodín)</span>
            <input
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              placeholder="node_modules, vendor, *.log, .env"
            />
          </label>
        ) : null}
      </div>

      {error ? <p className="error-banner">{error}</p> : null}
      {toast ? <p className="ok-banner">{toast}</p> : null}

      <div className="compare-body" ref={bodyRef}>
        {listHidden ? (
          <div className="list-rail">
            <button
              type="button"
              className="ghost small icon"
              onClick={() => setListHidden(false)}
              title="Mostrar las carpetas"
              aria-label="Mostrar las carpetas"
            >
              »
            </button>
          </div>
        ) : (
          <>
            <div
              className="file-list"
              style={{ '--list-width': `${listWidth}px` } as CSSProperties}
            >
              <div className="file-list-head">
                <span>{result ? `${visibleEntries.length} archivo(s)` : 'Sin comparar'}</span>
                <span className="tree-buttons">
                  {result ? (
                    <>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => setExpanded(new Set(collectDirPaths(tree)))}
                      >
                        Expandir
                      </button>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => setExpanded(new Set())}
                      >
                        Cerrar
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="ghost small icon"
                    onClick={() => setListHidden(true)}
                    title="Ocultar las carpetas"
                    aria-label="Ocultar las carpetas"
                  >
                    «
                  </button>
                </span>
              </div>
              {result?.truncated ? (
                <p className="truncate-warning">
                  Se alcanzó el límite de archivos por lado: puede haber archivos que no aparecen
                  en la lista. Compara carpetas más pequeñas o excluye las pesadas.
                </p>
              ) : null}
              {result ? (
                <p className="list-note">
                  {result.excludedDirs.toLocaleString('es')} carpetas y{' '}
                  {result.excludedFiles.toLocaleString('es')} archivos ignorados ·{' '}
                  {result.dirsScanned.toLocaleString('es')} carpetas revisadas
                </p>
              ) : null}
              {result && visibleEntries.length > 0 ? (
                <FileTree
                  nodes={tree}
                  activePath={activeRel}
                  expanded={expanded}
                  onToggle={toggleDir}
                  onSelect={(entry) => void openFile(entry)}
                />
              ) : null}
              {result && visibleEntries.length === 0 ? (
                <p className="empty-hint">No hay diferencias.</p>
              ) : null}
              {!result ? <p className="empty-hint">Elige las carpetas y pulsa Comparar.</p> : null}
            </div>

            <div
              className="list-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Ancho de la lista de carpetas"
              title="Arrastra para cambiar el ancho (o usa las flechas)"
              tabIndex={0}
              onPointerDown={beginListDrag}
              onPointerMove={moveListDrag}
              onPointerUp={endListDrag}
              onPointerCancel={endListDrag}
              onKeyDown={nudgeList}
            />
          </>
        )}

        <div className="diff-area">
          {pairLoading ? <p className="empty-hint">Cargando archivo…</p> : null}
          {!pairLoading && pair ? (
            <DiffView
              key={`${pair.remotePath}::${pair.remoteHash}`}
              serverId={profile.id}
              remoteRoot={remotePath}
              localRoot={localPath}
              pair={pair}
              onUploaded={refreshed}
              onDownloaded={refreshed}
            />
          ) : null}
          {!pairLoading && !pair ? (
            <p className="empty-hint">Selecciona un archivo de la lista para ver los cambios.</p>
          ) : null}
        </div>
      </div>

      {localBrowserOpen ? (
        <LocalPathBrowser
          mode="directory"
          initialPath={localPath}
          title="Elegir carpeta en el equipo del servicio"
          onClose={() => setLocalBrowserOpen(false)}
          onPick={(picked) => {
            setLocalPath(picked)
            setLocalBrowserOpen(false)
          }}
        />
      ) : null}

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
