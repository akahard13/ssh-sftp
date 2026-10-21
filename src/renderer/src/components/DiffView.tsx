import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { FilePair } from '../../../shared/types'
import { buildDiff, buildResult, newFileDiff, splitLines } from '../lib/merge'

const MISSING_REMOTE_HASH = 'MISSING'

interface DiffViewProps {
  serverId: string
  pair: FilePair
  onUploaded: (message: string) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function DiffView({ serverId, pair, onUploaded }: DiffViewProps): JSX.Element {
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
  const [backup, setBackup] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const rows = useMemo(() => {
    let previousHunk: string | null = null
    return model.rows.map((row) => {
      const isFirstOfHunk = row.kind === 'change' && row.hunkId !== previousHunk
      previousHunk = row.kind === 'change' ? row.hunkId : null
      return { row, isFirstOfHunk }
    })
  }, [model.rows])

  const isNewFile = pair.remoteHash === MISSING_REMOTE_HASH

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
      const result = await window.api.files.upload({
        serverId,
        remotePath: pair.remotePath,
        content: generated,
        expectedRemoteHash: pair.remoteHash,
        backup
      })
      const detail = result.backupPath ? ` Respaldo: ${result.backupPath}` : ''
      onUploaded(`${pair.relPath} subido (${formatSize(result.bytes)}).${detail}`)
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

      <div className={`diff-body ${showResult ? 'with-result' : ''}`}>
        <div className="diff-scroll">
          <div className="diff-columns">
            <span className="diff-col-label">
              Servidor {isNewFile ? '(no existe)' : '(remoto)'}
            </span>
            <span className="diff-col-label">Local</span>
          </div>
          <div className="diff-grid">
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
                  <div className="diff-row equal" key={row.key}>
                    <span className="diff-gutter" />
                    <span className="diff-no">{row.aNo}</span>
                    <span className="diff-code">{row.text}</span>
                    <span className="diff-no">{row.bNo}</span>
                    <span className="diff-code">{row.text}</span>
                  </div>
                )
              }
              const applied = selected.has(row.hunkId)
              return (
                <div className={`diff-row change ${applied ? 'applied' : ''}`} key={row.key}>
                  <span className="diff-gutter">
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
                  <span className={`diff-no ${row.add ? 'add' : ''}`}>{row.add?.no ?? ''}</span>
                  <span className={`diff-code ${row.add ? 'add' : 'blank'}`}>{row.add?.text ?? ''}</span>
                </div>
              )
            })}
          </div>
        </div>

        {showResult ? (
          <aside className="result-pane">
            <div className="diff-col-label">Resultado generado</div>
            <pre>{generated}</pre>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
