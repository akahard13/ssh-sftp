import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type {
  CompareEntry,
  CompareProgress,
  CompareResult,
  DeploySessionSummary,
  FilePair,
  ServerProfile
} from '../../../shared/types'
import DiffView from './DiffView'
import FileTree from './FileTree'
import LocalPathBrowser from './LocalPathBrowser'
import PathListDialog from './PathListDialog'
import RemotePathBrowser from './RemotePathBrowser'
import UploadConfirm from './UploadConfirm'
import { api } from '../lib/api'
import { buildTree, collectDirPaths } from '../lib/tree'

const LIST_MIN_WIDTH = 140
const LIST_MAX_RATIO = 0.6
const LIST_DEFAULT_WIDTH = 300
/** Carpeta, dentro del proyecto remoto, donde se respalda lo reemplazado. */
const BACKUP_DIR = 'backup_files'

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
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null)
  const [pathsOpen, setPathsOpen] = useState(false)
  const [pathsBusy, setPathsBusy] = useState(false)
  /** Archivos resueltos desde las rutas pegadas; null cuando no está activo. */
  const [pathEntries, setPathEntries] = useState<CompareEntry[] | null>(null)
  const [pathRaw, setPathRaw] = useState<string[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [excludeText, setExcludeText] = useState('')
  const [excludeOpen, setExcludeOpen] = useState(false)
  /** Sesión de despliegue abierta; sin ella las subidas se rechazan. */
  const [deploySession, setDeploySession] = useState<DeploySessionSummary | null>(null)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [listWidth, setListWidth] = useState(LIST_DEFAULT_WIDTH)
  const [listHidden, setListHidden] = useState(false)
  const activeRequest = useRef<string | null>(null)
  const bulkRequest = useRef<string | null>(null)
  /** Última ruta abierta, para no volver a ella si el usuario ya se movió. */
  const activeRelRef = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const listDrag = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    return api.compare.onProgress((incoming) => {
      if (incoming.requestId === activeRequest.current) setProgress(incoming)
    })
  }, [])

  useEffect(() => {
    return api.files.onUploadProgress((incoming) => {
      if (incoming.requestId !== bulkRequest.current) return
      setBulk({ done: incoming.done, total: incoming.total })
    })
  }, [])

  useEffect(() => {
    void api.compare.defaults().then(({ defaults, saved }) => {
      setExcludeText((saved ?? defaults).join(', '))
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    setDeploySession(null)
    void api.deploy
      .active(profile.id)
      .then((active) => {
        if (!cancelled) setDeploySession(active)
      })
      .catch(() => {
        /* el botón de iniciar sigue disponible */
      })
    return () => {
      cancelled = true
    }
  }, [profile.id])

  const startDeploySession = async (): Promise<void> => {
    setError(null)
    setToast(null)
    setSessionBusy(true)
    try {
      const session = await api.deploy.start({
        serverId: profile.id,
        remoteRoot: remotePath,
        localRoot: localPath
      })
      setDeploySession(session)
      setToast('Sesión de despliegue iniciada. Todo lo que subas quedará en su registro.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar la sesión de despliegue.')
    } finally {
      setSessionBusy(false)
    }
  }

  const endDeploySession = async (): Promise<void> => {
    if (!deploySession) return
    setError(null)
    setToast(null)
    setSessionBusy(true)
    try {
      const closed = await api.deploy.end(deploySession.id)
      setDeploySession(null)
      setToast(
        `Sesión de despliegue finalizada: ${closed.totals.uploaded} archivo(s) subido(s). ` +
          'El registro quedó guardado y se puede exportar desde Datos.'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo finalizar la sesión de despliegue.')
    } finally {
      setSessionBusy(false)
    }
  }

  useEffect(() => {
    setLocalPath(profile.localRoot ?? '')
    setRemotePath(profile.remoteRoot ?? '/')
    setResult(null)
    setPair(null)
    setActiveRel(null)
    activeRelRef.current = null
    setError(null)
    setToast(null)
    setPathEntries(null)
    setPathRaw([])
    setChecked(new Set())
  }, [profile.id, profile.localRoot, profile.remoteRoot])

  const visibleEntries = useMemo(() => {
    if (!result) return []
    if (!onlyChanges) return result.entries
    return result.entries.filter((entry) => entry.status !== 'identical')
  }, [result, onlyChanges])

  const tree = useMemo(() => buildTree(visibleEntries), [visibleEntries])

  const pathMode = pathEntries !== null
  const pathTree = useMemo(() => (pathEntries ? buildTree(pathEntries) : []), [pathEntries])
  const selectedPaths = useMemo(
    () => (pathEntries ?? []).filter((entry) => checked.has(entry.relPath)).map((entry) => entry.relPath),
    [pathEntries, checked]
  )

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
    if (pathMode) {
      setPathEntries(null)
      setPathRaw([])
      setChecked(new Set())
    }
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
      activeRelRef.current = null
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
    activeRelRef.current = entry.relPath
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

  /**
   * Rehace la comparación tras subir o descargar. Solo vuelve a cargar el par de
   * la vista abierta si el usuario sigue en ese mismo archivo; si se movió a otro,
   * se respeta su selección en vez de devolverlo al anterior.
   */
  const refreshAfterChange = async (changedRel: string | null): Promise<void> => {
    const compared = await runCompareRequest()
    if (!compared) return
    setResult(compared)
    if (!changedRel || activeRelRef.current !== changedRel) return
    try {
      const reloaded = await api.files.readPair(profile.id, remotePath, localPath, changedRel)
      if (activeRelRef.current !== changedRel) return
      setPair(reloaded)
    } catch {
      /* el archivo pudo desaparecer; se deja la vista como está */
    }
  }

  const afterFileChange = (message: string, relPath: string): void => {
    setToast(message)
    void refreshAfterChange(relPath).catch(() => {
      /* la comparación se puede repetir manualmente */
    })
  }

  const uploadDir = async (dirPath: string, dirName: string): Promise<void> => {
    if (!result) return
    if (!deploySession) {
      setError('Inicia una sesión de despliegue antes de subir archivos.')
      return
    }
    const prefix = dirPath ? `${dirPath}/` : ''
    const relPaths = result.entries
      .filter(
        (entry) =>
          entry.relPath.startsWith(prefix) &&
          entry.localSize !== null &&
          entry.status !== 'identical' &&
          entry.status !== 'remote-only'
      )
      .map((entry) => entry.relPath)

    if (relPaths.length === 0) {
      setToast(`No hay archivos locales que subir en "${dirName}".`)
      return
    }
    const confirmed = window.confirm(
      `Se subirán ${relPaths.length} archivo(s) de "${dirName}" tal como están en local. ` +
        'Los que ya existan en el servidor se reemplazan con el contenido local. ¿Continuar?'
    )
    if (!confirmed) return

    setError(null)
    setToast(null)
    const requestId = newRequestId()
    bulkRequest.current = requestId
    setBulk({ done: 0, total: relPaths.length })
    try {
      const summary = await api.files.uploadMany({
        requestId,
        serverId: profile.id,
        sessionId: deploySession.id,
        remoteRoot: remotePath,
        localRoot: localPath,
        relPaths,
        backup: false
      })
      const parts: string[] = []
      if (summary.uploaded > 0) parts.push(`${summary.uploaded} archivo(s) subido(s)`)
      if (summary.skipped > 0) parts.push(`${summary.skipped} sin cambios`)
      if (summary.errors.length > 0) parts.push(`${summary.errors.length} con error`)
      setToast(parts.length > 0 ? `${parts.join(' · ')}.` : 'No había nada que subir.')
      if (summary.errors.length > 0) {
        const detail = summary.errors
          .slice(0, 3)
          .map((item) => `${item.relPath}: ${item.message}`)
          .join(' | ')
        const extra = summary.errors.length > 3 ? ' …' : ''
        setError(`No se pudieron subir ${summary.errors.length} archivo(s): ${detail}${extra}`)
      }
      try {
        await refreshAfterChange(activeRelRef.current)
      } catch {
        /* la comparación se puede repetir manualmente */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron subir los archivos.')
    } finally {
      bulkRequest.current = null
      setBulk(null)
    }
  }

  const exitPathMode = (): void => {
    setPathEntries(null)
    setPathRaw([])
    setChecked(new Set())
    setPair(null)
    setActiveRel(null)
    activeRelRef.current = null
  }

  const loadPaths = async (paths: string[]): Promise<void> => {
    setPathsOpen(false)
    if (paths.length === 0) return
    setError(null)
    setToast(null)
    if (!localPath.trim()) {
      setError('Selecciona un directorio local.')
      return
    }
    setPathsBusy(true)
    try {
      const loaded = await api.files.listPaths({
        serverId: profile.id,
        remoteRoot: remotePath,
        localRoot: localPath,
        paths
      })
      setPathRaw(paths)
      setPathEntries(loaded.entries)
      setChecked(new Set(loaded.entries.map((entry) => entry.relPath)))
      setExpanded(new Set(collectDirPaths(buildTree(loaded.entries))))
      setPair(null)
      setActiveRel(null)
      activeRelRef.current = null
      if (loaded.errors.length > 0) {
        const detail = loaded.errors
          .slice(0, 3)
          .map((item) => `${item.path}: ${item.message}`)
          .join(' | ')
        const extra = loaded.errors.length > 3 ? ' …' : ''
        setError(`${loaded.errors.length} ruta(s) no se pudieron leer: ${detail}${extra}`)
      }
      if (loaded.truncated) {
        setToast(
          `Se listaron los primeros ${loaded.entries.length} archivos; acota las rutas para ver el resto.`
        )
      } else if (loaded.entries.length === 0 && loaded.errors.length === 0) {
        setToast('No se encontraron archivos en esas rutas.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron leer las rutas.')
    } finally {
      setPathsBusy(false)
    }
  }

  const toggleCheck = (relPath: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  const toggleDirCheck = (dirPath: string): void => {
    const prefix = dirPath ? `${dirPath}/` : ''
    const inside = (pathEntries ?? [])
      .filter((entry) => entry.relPath.startsWith(prefix))
      .map((entry) => entry.relPath)
    const allChecked = inside.length > 0 && inside.every((relPath) => checked.has(relPath))
    setChecked((prev) => {
      const next = new Set(prev)
      for (const relPath of inside) {
        if (allChecked) next.delete(relPath)
        else next.add(relPath)
      }
      return next
    })
  }

  const selectAllPaths = (): void => {
    setChecked(new Set((pathEntries ?? []).map((entry) => entry.relPath)))
  }

  const selectNoPaths = (): void => {
    setChecked(new Set())
  }

  const uploadPaths = async (relPaths: string[]): Promise<void> => {
    setConfirmOpen(false)
    if (relPaths.length === 0) return
    if (!deploySession) {
      setError('Inicia una sesión de despliegue antes de subir archivos.')
      return
    }
    setError(null)
    setToast(null)
    const requestId = newRequestId()
    bulkRequest.current = requestId
    setBulk({ done: 0, total: relPaths.length })
    try {
      const summary = await api.files.uploadMany({
        requestId,
        serverId: profile.id,
        sessionId: deploySession.id,
        remoteRoot: remotePath,
        localRoot: localPath,
        relPaths,
        backup: false,
        backupFolder: BACKUP_DIR
      })
      const parts: string[] = []
      if (summary.uploaded > 0) parts.push(`${summary.uploaded} archivo(s) subido(s)`)
      if (summary.skipped > 0) parts.push(`${summary.skipped} sin cambios`)
      if (summary.errors.length > 0) parts.push(`${summary.errors.length} con error`)
      const where = summary.backupRoot ? ` Respaldo en ${summary.backupRoot}.` : ''
      setToast(parts.length > 0 ? `${parts.join(' · ')}.${where}` : 'No había nada que subir.')
      if (summary.errors.length > 0) {
        const detail = summary.errors
          .slice(0, 3)
          .map((item) => `${item.relPath}: ${item.message}`)
          .join(' | ')
        const extra = summary.errors.length > 3 ? ' …' : ''
        setError(`No se pudieron subir ${summary.errors.length} archivo(s): ${detail}${extra}`)
      }
      if (pathRaw.length > 0) {
        const refreshed = await api.files.listPaths({
          serverId: profile.id,
          remoteRoot: remotePath,
          localRoot: localPath,
          paths: pathRaw
        })
        setPathEntries(refreshed.entries)
        const available = new Set(refreshed.entries.map((entry) => entry.relPath))
        setChecked((prev) => new Set([...prev].filter((relPath) => available.has(relPath))))
      }
      const opened = activeRelRef.current
      if (opened && relPaths.includes(opened)) {
        try {
          setPair(await api.files.readPair(profile.id, remotePath, localPath, opened))
        } catch {
          /* el archivo pudo desaparecer; se deja la vista como está */
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron subir los archivos.')
    } finally {
      bulkRequest.current = null
      setBulk(null)
    }
  }

  useEffect(() => {
    if (pathEntries === null) return
    exitPathMode()
    // Las rutas pegadas dejan de ser válidas si cambian las raíces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPath, remotePath])

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
        <button
          type="button"
          className="ghost"
          onClick={() => setPathsOpen(true)}
          disabled={busy || pathsBusy}
          title="Pega una lista de rutas del proyecto local y elige cuáles subir"
        >
          {pathsBusy ? 'Leyendo rutas…' : 'Subir por rutas…'}
        </button>
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

      <div className={`deploy-bar ${deploySession ? 'active' : ''}`}>
        {deploySession ? (
          <>
            <span className="deploy-dot" aria-hidden="true" />
            <span>
              Sesión de despliegue activa desde las{' '}
              {new Date(deploySession.startedAt).toLocaleTimeString('es', {
                hour: '2-digit',
                minute: '2-digit'
              })}{' '}
              · {deploySession.totals.uploaded} archivo(s) subido(s)
            </span>
            <button
              type="button"
              className="ghost small"
              onClick={() => void endDeploySession()}
              disabled={sessionBusy || bulk !== null}
            >
              {sessionBusy ? 'Finalizando…' : 'Finalizar sesión de despliegue'}
            </button>
          </>
        ) : (
          <>
            <span className="muted">
              Sin sesión de despliegue: iníciala para poder subir archivos.
            </span>
            <button
              type="button"
              className="primary small"
              onClick={() => void startDeploySession()}
              disabled={sessionBusy}
            >
              {sessionBusy ? 'Iniciando…' : 'Iniciar sesión de despliegue'}
            </button>
          </>
        )}
      </div>

      {error ? <p className="error-banner">{error}</p> : null}
      {toast ? <p className="ok-banner">{toast}</p> : null}
      {bulk ? (
        <p className="ok-banner">
          Subiendo {bulk.done} de {bulk.total} archivo(s)… no cierres la ventana.
        </p>
      ) : null}

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
                <span>
                  {pathMode
                    ? `${pathEntries?.length ?? 0} archivo(s) de ${pathRaw.length} ruta(s)`
                    : result
                      ? `${visibleEntries.length} archivo(s)`
                      : 'Sin comparar'}
                </span>
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
              {pathMode ? (
                <div className="path-mode-bar">
                  <span className="muted">
                    {checked.size} de {pathEntries?.length ?? 0} seleccionado(s)
                  </span>
                  <button type="button" className="ghost small" onClick={selectAllPaths}>
                    Todos
                  </button>
                  <button type="button" className="ghost small" onClick={selectNoPaths}>
                    Ninguno
                  </button>
                  <button
                    type="button"
                    className="primary small"
                    onClick={() => setConfirmOpen(true)}
                    disabled={checked.size === 0 || bulk !== null || !deploySession}
                    title={deploySession ? undefined : 'Inicia una sesión de despliegue para subir'}
                  >
                    Subir seleccionados
                  </button>
                  <button type="button" className="ghost small" onClick={exitPathMode}>
                    Salir
                  </button>
                </div>
              ) : null}
              {!pathMode && result?.truncated ? (
                <p className="truncate-warning">
                  Se alcanzó el límite de archivos por lado: puede haber archivos que no aparecen
                  en la lista. Compara carpetas más pequeñas o excluye las pesadas.
                </p>
              ) : null}
              {!pathMode && result ? (
                <p className="list-note">
                  {result.excludedDirs.toLocaleString('es')} carpetas y{' '}
                  {result.excludedFiles.toLocaleString('es')} archivos ignorados ·{' '}
                  {result.dirsScanned.toLocaleString('es')} carpetas revisadas
                </p>
              ) : null}
              {pathMode ? (
                pathEntries && pathEntries.length > 0 ? (
                  <FileTree
                    nodes={pathTree}
                    activePath={activeRel}
                    expanded={expanded}
                    onToggle={toggleDir}
                    onSelect={(entry) => void openFile(entry)}
                    checked={checked}
                    onToggleCheck={toggleCheck}
                    onToggleDirCheck={toggleDirCheck}
                  />
                ) : (
                  <p className="empty-hint">Ninguna ruta se pudo leer.</p>
                )
              ) : (
                <>
                  {result && visibleEntries.length > 0 ? (
                    <FileTree
                      nodes={tree}
                      activePath={activeRel}
                      expanded={expanded}
                      onToggle={toggleDir}
                      onSelect={(entry) => void openFile(entry)}
                      onUploadDir={(path, name) => void uploadDir(path, name)}
                      uploading={bulk !== null}
                    />
                  ) : null}
                  {result && visibleEntries.length === 0 ? (
                    <p className="empty-hint">No hay diferencias.</p>
                  ) : null}
                  {!result ? <p className="empty-hint">Elige las carpetas y pulsa Comparar.</p> : null}
                </>
              )}
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
              sessionId={deploySession?.id ?? null}
              onUploaded={afterFileChange}
              onDownloaded={afterFileChange}
            />
          ) : null}
          {!pairLoading && !pair ? (
            <p className="empty-hint">Selecciona un archivo de la lista para ver los cambios.</p>
          ) : null}
        </div>
      </div>

      {pathsOpen ? (
        <PathListDialog
          localRoot={localPath}
          initial={pathRaw.join('\n')}
          onClose={() => setPathsOpen(false)}
          onSubmit={(paths) => void loadPaths(paths)}
        />
      ) : null}

      {confirmOpen && selectedPaths.length > 0 ? (
        <UploadConfirm
          remoteRoot={remotePath}
          backupFolder={BACKUP_DIR}
          relPaths={selectedPaths}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => void uploadPaths(selectedPaths)}
        />
      ) : null}

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
