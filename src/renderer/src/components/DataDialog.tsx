import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, JSX } from 'react'
import type { DeployFileRecord, DeploySession, DeploySessionSummary } from '../../../shared/types'
import { api } from '../lib/api'
import { downloadJson, readTextFile } from '../lib/download'
import Modal from './Modal'

interface DataDialogProps {
  onClose: () => void
  /** El sidebar recarga los servidores tras importar una configuración. */
  onServersChanged: () => void
}

const OUTCOME_LABEL: Record<DeployFileRecord['outcome'], string> = {
  uploaded: 'subido',
  skipped: 'sin cambios',
  error: 'error'
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('es')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function DataDialog({ onClose, onServersChanged }: DataDialogProps): JSX.Element {
  const [sessions, setSessions] = useState<DeploySessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [replaceHistory, setReplaceHistory] = useState(false)
  const [replaceConfig, setReplaceConfig] = useState(false)
  const [detail, setDetail] = useState<DeploySession | null>(null)
  const [detailBusy, setDetailBusy] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)
  const historyInput = useRef<HTMLInputElement>(null)
  const configInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setSessions(await api.deploy.list())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo leer el historial.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const fail = (err: unknown, fallback: string): void => {
    setError(err instanceof Error ? err.message : fallback)
  }

  const exportHistory = async (): Promise<void> => {
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      const bundle = await api.deploy.exportHistory()
      downloadJson(`deploysync-historial-${stamp()}.json`, bundle)
      setMessage(`Historial exportado con ${bundle.sessions.length} sesión(es).`)
    } catch (err) {
      fail(err, 'No se pudo exportar el historial.')
    } finally {
      setBusy(false)
    }
  }

  const importHistory = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      const result = await api.deploy.importHistory(await readTextFile(file), replaceHistory)
      const skipped = result.skipped > 0 ? ` · ${result.skipped} ya existían` : ''
      setMessage(`Historial importado: ${result.imported} de ${result.total} sesión(es)${skipped}.`)
      setDetail(null)
      await refresh()
    } catch (err) {
      fail(err, 'No se pudo importar el historial.')
    } finally {
      setBusy(false)
    }
  }

  const exportConfig = async (): Promise<void> => {
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      const bundle = await api.config.exportServers()
      downloadJson(`deploysync-config-${stamp()}.json`, bundle)
      setMessage(`Configuración exportada con ${bundle.servers.length} servidor(es).`)
    } catch (err) {
      fail(err, 'No se pudo exportar la configuración.')
    } finally {
      setBusy(false)
    }
  }

  const importConfig = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (
      replaceConfig &&
      !window.confirm(
        'Se borrarán los servidores que no estén en el archivo (y sus contraseñas guardadas). ¿Continuar?'
      )
    ) {
      return
    }
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      const result = await api.config.importServers(await readTextFile(file), replaceConfig)
      setMessage(
        `Configuración importada: ${result.created} nuevo(s), ${result.updated} actualizado(s). ` +
          'Las contraseñas no vienen en el archivo: escríbelas al conectar.'
      )
      onServersChanged()
    } catch (err) {
      fail(err, 'No se pudo importar la configuración.')
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (session: DeploySessionSummary): Promise<void> => {
    setError(null)
    setDetailBusy(session.id)
    try {
      setDetail(await api.deploy.get(session.id))
    } catch (err) {
      fail(err, 'No se pudo leer la sesión.')
    } finally {
      setDetailBusy(null)
    }
  }

  const revertFile = async (session: DeploySession, file: DeployFileRecord): Promise<void> => {
    if (
      !window.confirm(
        `Se restaurará "${file.relPath}" en el servidor desde su respaldo:\n${file.backupPath}\n\n` +
          'La versión actual se guardará como un .bak nuevo. ¿Continuar?'
      )
    ) {
      return
    }
    setError(null)
    setMessage(null)
    setReverting(file.id)
    try {
      const result = await api.deploy.revertFile(session.id, file.id)
      setMessage(
        `"${file.relPath}" restaurado desde el respaldo (${formatBytes(result.bytes)}).` +
          (result.discardedBackup ? ` La versión desplegada quedó en ${result.discardedBackup}.` : '')
      )
      setDetail(await api.deploy.get(session.id))
      await refresh()
    } catch (err) {
      fail(err, 'No se pudo revertir el archivo.')
    } finally {
      setReverting(null)
    }
  }

  const removeSession = async (session: DeploySessionSummary): Promise<void> => {
    if (!window.confirm(`¿Borrar el registro del despliegue del ${formatDate(session.startedAt)}?`)) {
      return
    }
    setError(null)
    setMessage(null)
    try {
      await api.deploy.remove(session.id)
      if (detail?.id === session.id) setDetail(null)
      setMessage('Registro de despliegue borrado.')
      await refresh()
    } catch (err) {
      fail(err, 'No se pudo borrar el registro.')
    }
  }

  return (
    <Modal
      title="Datos y configuración"
      width={840}
      onClose={onClose}
      footer={
        <button type="button" className="ghost" onClick={onClose}>
          Cerrar
        </button>
      }
    >
      {error ? <p className="error-banner">{error}</p> : null}
      {message ? <p className="ok-banner">{message}</p> : null}

      <section className="data-section">
        <h3>Historial de despliegues</h3>
        <p className="hint">
          Cada sesión de despliegue guarda un JSON con los archivos subidos entre «Iniciar sesión de
          despliegue» y «Finalizar sesión de despliegue». {sessions.length} sesión(es) registrada(s).
        </p>
        <div className="data-actions">
          <button
            type="button"
            className="ghost small"
            onClick={() => void exportHistory()}
            disabled={busy || sessions.length === 0}
          >
            Exportar historial (JSON)
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => historyInput.current?.click()}
            disabled={busy}
          >
            Importar historial…
          </button>
          <label className="checkbox small">
            <input
              type="checkbox"
              checked={replaceHistory}
              onChange={(e) => setReplaceHistory(e.target.checked)}
            />
            Reemplazar el historial actual
          </label>
          <button
            type="button"
            className="ghost small"
            onClick={() => void refresh()}
            disabled={busy || loading}
          >
            {loading ? 'Leyendo…' : 'Actualizar'}
          </button>
          <input
            ref={historyInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void importHistory(e)}
          />
        </div>

        {!loading && sessions.length === 0 ? (
          <p className="empty-hint">Todavía no hay sesiones de despliegue.</p>
        ) : null}

        {sessions.length > 0 ? (
          <div className="session-list">
            <table className="session-table">
              <thead>
                <tr>
                  <th>Inicio</th>
                  <th>Servidor</th>
                  <th>Archivos</th>
                  <th>Tamaño</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td>{formatDate(session.startedAt)}</td>
                    <td>
                      {session.serverName}
                      <span className="muted"> · {session.host}</span>
                    </td>
                    <td>
                      {session.totals.uploaded} subido(s)
                      {session.totals.skipped > 0 ? ` · ${session.totals.skipped} sin cambios` : ''}
                      {session.totals.errors > 0 ? ` · ${session.totals.errors} error(es)` : ''}
                    </td>
                    <td>{formatBytes(session.totals.bytes)}</td>
                    <td>{session.status === 'active' ? 'activa' : 'finalizada'}</td>
                    <td className="session-row-actions">
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => void openDetail(session)}
                        disabled={detailBusy === session.id}
                      >
                        {detailBusy === session.id ? '…' : 'Ver'}
                      </button>
                      <button
                        type="button"
                        className="ghost small danger"
                        onClick={() => void removeSession(session)}
                        disabled={busy || session.status === 'active'}
                        title={
                          session.status === 'active'
                            ? 'Finaliza la sesión antes de borrar su registro'
                            : 'Borrar este registro'
                        }
                      >
                        Borrar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {detail ? (
          <div className="session-detail">
            <div className="session-detail-head">
              <strong>{detail.serverName}</strong>
              <span className="muted">
                {formatDate(detail.startedAt)}
                {detail.endedAt ? ` → ${formatDate(detail.endedAt)}` : ' · activa'}
              </span>
              <span className="muted mono">
                {detail.localRoot || 'sin raíz local'} → {detail.remoteRoot || 'sin raíz remota'}
              </span>
              <button type="button" className="ghost small" onClick={() => setDetail(null)}>
                Cerrar detalle
              </button>
            </div>
            {detail.files.length === 0 ? (
              <p className="empty-hint">Esta sesión no registró archivos.</p>
            ) : (
              <div className="session-list tall">
                <table className="session-table">
                  <thead>
                    <tr>
                      <th>Archivo</th>
                      <th>Destino</th>
                      <th>Respaldo</th>
                      <th>Resultado</th>
                      <th>Tamaño</th>
                      <th>Hora</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.files.map((file, index) => (
                      <tr key={`${file.id}-${index}`}>
                        <td>{file.relPath}</td>
                        <td className="mono">{file.remotePath}</td>
                        <td className="mono" title={file.backupPath ?? undefined}>
                          {file.backupPath ?? '—'}
                        </td>
                        <td className={file.outcome === 'error' ? 'danger-text' : undefined}>
                          {OUTCOME_LABEL[file.outcome]}
                          {file.message ? `: ${file.message}` : ''}
                          {file.revertedAt ? (
                            <span className="muted"> · revertido {formatDate(file.revertedAt)}</span>
                          ) : null}
                        </td>
                        <td>{formatBytes(file.bytes)}</td>
                        <td>{new Date(file.at).toLocaleTimeString('es')}</td>
                        <td className="session-row-actions">
                          {file.outcome === 'uploaded' && file.backupPath ? (
                            <button
                              type="button"
                              className="ghost small"
                              onClick={() => void revertFile(detail, file)}
                              disabled={reverting !== null}
                              title={`Restaurar en el servidor desde ${file.backupPath}`}
                            >
                              {reverting === file.id ? 'Revirtiendo…' : 'Revertir'}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </section>

      <section className="data-section">
        <h3>Configuración de servidores</h3>
        <p className="hint">
          Exporta los servidores registrados (nombre, host, puerto, usuario, autenticación, rutas y
          bastión). Las contraseñas y passphrases <strong>no</strong> se exportan: tendrás que
          escribirlas otra vez al conectar.
        </p>
        <div className="data-actions">
          <button
            type="button"
            className="ghost small"
            onClick={() => void exportConfig()}
            disabled={busy}
          >
            Exportar configuración (JSON)
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => configInput.current?.click()}
            disabled={busy}
          >
            Importar configuración…
          </button>
          <label className="checkbox small">
            <input
              type="checkbox"
              checked={replaceConfig}
              onChange={(e) => setReplaceConfig(e.target.checked)}
            />
            Reemplazar los servidores actuales
          </label>
          <input
            ref={configInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void importConfig(e)}
          />
        </div>
      </section>
    </Modal>
  )
}
