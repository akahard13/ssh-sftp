import { useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { FilePair } from '../../../shared/types'
import { api } from '../lib/api'
import { buildDiff, buildResult, newFileDiff, splitLines } from '../lib/merge'

const MISSING_REMOTE_HASH = 'MISSING'
const MIN_SHARE = 0.1

interface DragState {
  divider: 'servers' | 'result'
  startX: number
  remote: number
  local: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

interface DiffViewProps {
  serverId: string
  remoteRoot: string
  localRoot: string
  pair: FilePair
  onUploaded: (message: string, relPath: string) => void
  onDownloaded: (message: string, relPath: string) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function DiffView({
  serverId,
  remoteRoot,
  localRoot,
  pair,
  onUploaded,
  onDownloaded
}: DiffViewProps): JSX.Element {
  const remoteLines = useMemo(() => splitLines(pair.remoteText), [pair])
  const localLines = useMemo(() => splitLines(pair.localText), [pair])

  const model = useMemo(
    () =>
      pair.remoteHash === MISSING_REMOTE_HASH
        ? newFileDiff(localLines)
        : buildDiff(remoteLines, localLines),
    [pair.remoteHash, remoteLines, localLines]
  )

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(model.hunks.map((hunk) => hunk.id))
  )
  const [showResult, setShowResult] = useState(true)
  const [backup, setBackup] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Proporciones de ancho de cada panel; los divisores las ajustan al arrastrar.
  const [split, setSplit] = useState({ remote: 0.34, local: 0.33 })
  const bodyRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  const generated = useMemo(
    () => buildResult(remoteLines, model.hunks, selected),
    [remoteLines, model.hunks, selected]
  )

  const toggleHunk = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const beginDrag =
    (divider: DragState['divider']) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        divider,
        startX: event.clientX,
        remote: split.remote,
        local: split.local
      }
    }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const width = bodyRef.current?.getBoundingClientRect().width ?? 0
    if (!drag || width === 0) return
    const delta = (event.clientX - drag.startX) / width
    if (drag.divider === 'servers') {
      const maxRemote = showResult ? 1 - drag.local - MIN_SHARE : 1 - MIN_SHARE
      setSplit({ remote: clamp(drag.remote + delta, MIN_SHARE, maxRemote), local: drag.local })
      return
    }
    const maxLocal = 1 - drag.remote - MIN_SHARE
    setSplit({ remote: drag.remote, local: clamp(drag.local + delta, MIN_SHARE, maxLocal) })
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const nudgeDivider =
    (divider: DragState['divider']) =>
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = 0.02
    const direction = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    if (direction === 0) return
    event.preventDefault()
    if (divider === 'servers') {
      const maxRemote = showResult ? 1 - split.local - MIN_SHARE : 1 - MIN_SHARE
      setSplit({ ...split, remote: clamp(split.remote + direction, MIN_SHARE, maxRemote) })
      return
    }
    setSplit({ ...split, local: clamp(split.local + direction, MIN_SHARE, 1 - split.remote - MIN_SHARE) })
  }

  const rows = useMemo(() => {
    let previousHunk: string | null = null
    return model.rows.map((row) => {
      const isFirstOfHunk = row.kind === 'change' && row.hunkId !== previousHunk
      previousHunk = row.kind === 'change' ? row.hunkId : null
      return { row, isFirstOfHunk }
    })
  }, [model.rows])

  const isNewFile = pair.remoteHash === MISSING_REMOTE_HASH

  const download = async (): Promise<void> => {
    setError(null)
    setMessage(null)
    setDownloading(true)
    try {
      const result = await api.files.download({
        serverId,
        remoteRoot,
        localRoot,
        relPath: pair.relPath
      })
      setMessage(`Descargado en ${result.localPath} (${formatSize(result.bytes)}).`)
      onDownloaded(`${pair.relPath} descargado (${formatSize(result.bytes)}).`, pair.relPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo descargar el archivo.')
    } finally {
      setDownloading(false)
    }
  }

  if (pair.localMissing) {
    const lines = pair.binary || pair.tooLarge ? [] : splitLines(pair.remoteText)
    return (
      <div className="diff-panel">
        <header className="diff-header">
          <div className="diff-title">
            <strong>{pair.relPath}</strong>
            <span className="muted">solo en el servidor · {formatSize(pair.remoteSize)}</span>
          </div>
          <div className="diff-actions">
            <button
              type="button"
              className="primary small"
              onClick={() => void download()}
              disabled={downloading}
            >
              {downloading ? 'Descargando…' : 'Descargar'}
            </button>
          </div>
        </header>
        {error ? <p className="error-banner">{error}</p> : null}
        {message ? <p className="ok-banner">{message}</p> : null}
        <div className="diff-body">
          <section className="diff-pane" style={{ flexGrow: 1 }}>
            <div className="diff-col-label">Servidor (remoto) — todavía no existe en local</div>
            {pair.binary ? (
              <p className="empty-hint">
                Es un archivo binario; descárgalo para tenerlo en el directorio local.
              </p>
            ) : pair.tooLarge ? (
              <p className="empty-hint">
                Demasiado grande para previsualizarlo ({formatSize(pair.remoteSize)}); puedes
                descargarlo igualmente.
              </p>
            ) : (
              <div className="diff-scroll">
                <div className="diff-rows">
                  {lines.map((text, index) => (
                    <div className="diff-line" key={index}>
                      <span className="diff-no">{index + 1}</span>
                      <span className="diff-code">{text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    )
  }

  if (pair.binary) {
    return (
      <div className="diff-panel">
        <p className="empty-hint">
          {pair.relPath} parece ser un archivo binario; no se puede comparar línea a línea.
        </p>
      </div>
    )
  }

  if (pair.tooLarge) {
    return (
      <div className="diff-panel">
        <p className="empty-hint">
          El archivo es demasiado grande para compararlo (límite 4 MB). Remoto:{' '}
          {formatSize(pair.remoteSize)}, local: {formatSize(pair.localSize)}.
        </p>
      </div>
    )
  }

  const upload = async (): Promise<void> => {
    setError(null)
    setMessage(null)
    if (selected.size === 0 && !isNewFile) {
      setError('Selecciona al menos un bloque de cambios.')
      return
    }
    setUploading(true)
    try {
      const result = await api.files.upload({
        serverId,
        remotePath: pair.remotePath,
        content: generated,
        expectedRemoteHash: pair.remoteHash,
        backup
      })
      const detail = result.backupPath ? ` Respaldo: ${result.backupPath}` : ''
      onUploaded(`${pair.relPath} subido (${formatSize(result.bytes)}).${detail}`, pair.relPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir el archivo.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="diff-panel">
      <header className="diff-header">
        <div className="diff-title">
          <strong>{pair.relPath}</strong>
          <span className="muted">
            remoto {formatSize(pair.remoteSize)} · local {formatSize(pair.localSize)} ·{' '}
            {model.hunks.length} bloque(s)
          </span>
        </div>
        <div className="diff-actions">
          <button
            type="button"
            className="ghost small"
            onClick={() => setSelected(new Set(model.hunks.map((h) => h.id)))}
          >
            Todo
          </button>
          <button type="button" className="ghost small" onClick={() => setSelected(new Set())}>
            Nada
          </button>
          <label className="checkbox small">
            <input type="checkbox" checked={showResult} onChange={(e) => setShowResult(e.target.checked)} />
            Ver resultado
          </label>
          <label className="checkbox small">
            <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
            Crear respaldo
          </label>
          <button type="button" className="primary small" onClick={() => void upload()} disabled={uploading}>
            {uploading ? 'Subiendo…' : 'Subir seleccionados'}
          </button>
        </div>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}
      {message ? <p className="ok-banner">{message}</p> : null}

      <div className="diff-body" ref={bodyRef}>
        <section className="diff-pane remote" style={{ flexGrow: split.remote }}>
          <div className="diff-col-label">Servidor {isNewFile ? '(no existe)' : '(remoto)'}</div>
          <div className="diff-scroll">
            <div className="diff-rows">
              {rows.map(({ row, isFirstOfHunk }) => {
                if (row.kind === 'collapse') {
                  return (
                    <div className="diff-collapse" key={row.key}>
                      ⋯ {row.count} línea(s) sin cambios ⋯
                    </div>
                  )
                }
                if (row.kind === 'equal') {
                  return (
                    <div className="diff-line" key={row.key}>
                      <span className="diff-gutter" />
                      <span className="diff-no">{row.aNo}</span>
                      <span className="diff-code">{row.text}</span>
                    </div>
                  )
                }
                const applied = selected.has(row.hunkId)
                return (
                  <div className="diff-line" key={row.key}>
                    <span className={`diff-gutter ${applied ? 'applied' : ''}`}>
                      {isFirstOfHunk ? (
                        <input
                          type="checkbox"
                          checked={applied}
                          onChange={() => toggleHunk(row.hunkId)}
                          title={applied ? 'Se subirá este bloque' : 'Este bloque no se subirá'}
                        />
                      ) : null}
                    </span>
                    <span className={`diff-no ${row.del ? 'del' : ''}`}>{row.del?.no ?? ''}</span>
                    <span className={`diff-code ${row.del ? 'del' : 'blank'}`}>{row.del?.text ?? ''}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        <div
          className="diff-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Ancho del panel servidor"
          tabIndex={0}
          onPointerDown={beginDrag('servers')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={nudgeDivider('servers')}
        />

        <section
          className="diff-pane local"
          style={{ flexGrow: showResult ? split.local : 1 - split.remote }}
        >
          <div className="diff-col-label">Local</div>
          <div className="diff-scroll">
            <div className="diff-rows">
              {rows.map(({ row }) => {
                if (row.kind === 'collapse') {
                  return <div className="diff-collapse gap" key={row.key} />
                }
                if (row.kind === 'equal') {
                  return (
                    <div className="diff-line" key={row.key}>
                      <span className="diff-no">{row.bNo}</span>
                      <span className="diff-code">{row.text}</span>
                    </div>
                  )
                }
                return (
                  <div className="diff-line" key={row.key}>
                    <span className={`diff-no ${row.add ? 'add' : ''}`}>{row.add?.no ?? ''}</span>
                    <span className={`diff-code ${row.add ? 'add' : 'blank'}`}>{row.add?.text ?? ''}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {showResult ? (
          <>
            <div
              className="diff-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Ancho del panel resultado"
              tabIndex={0}
              onPointerDown={beginDrag('result')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={nudgeDivider('result')}
            />
            <aside
              className="result-pane"
              style={{ flexGrow: Math.max(MIN_SHARE, 1 - split.remote - split.local) }}
            >
              <div className="diff-col-label">Resultado generado</div>
              <pre>{generated}</pre>
            </aside>
          </>
        ) : null}
      </div>
    </div>
  )
}
