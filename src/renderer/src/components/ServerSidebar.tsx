import type { JSX, ReactNode } from 'react'
import type { ConnectionStatus, ServerProfile } from '../../../shared/types'

interface SidebarProps {
  servers: ServerProfile[]
  statuses: Record<string, ConnectionStatus>
  activeId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (profile: ServerProfile) => void
  onDelete: (profile: ServerProfile) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  footer?: ReactNode
}

function statusLabel(status: ConnectionStatus | undefined): string {
  switch (status?.state) {
    case 'ready':
      return 'conectado'
    case 'connecting':
      return 'conectando…'
    case 'needs-auth':
      return 'esperando código'
    case 'error':
      return 'error'
    default:
      return 'desconectado'
  }
}

export default function ServerSidebar({
  servers,
  statuses,
  activeId,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
  onConnect,
  onDisconnect,
  footer
}: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="brand">DeploySync</span>
        <button type="button" className="primary small" onClick={onAdd}>
          + Servidor
        </button>
      </div>
      <ul className="server-list">
        {servers.map((server) => {
          const status = statuses[server.id]
          const state = status?.state ?? 'disconnected'
          return (
            <li
              key={server.id}
              className={`server-item ${activeId === server.id ? 'active' : ''}`}
              onClick={() => onSelect(server.id)}
            >
              <div className="server-main">
                <span className={`dot ${state}`} aria-hidden="true" />
                <div className="server-text">
                  <span className="server-name">{server.name}</span>
                  <span className="server-host">
                    {server.username}@{server.host}
                  </span>
                </div>
              </div>
              <div className="server-actions">
                <span className="status-text" title={status?.message ?? statusLabel(status)}>
                  {statusLabel(status)}
                </span>
                {state === 'ready' || state === 'connecting' || state === 'needs-auth' ? (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={(event) => {
                      event.stopPropagation()
                      onDisconnect(server.id)
                    }}
                  >
                    Desconectar
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={(event) => {
                      event.stopPropagation()
                      onConnect(server.id)
                    }}
                  >
                    Conectar
                  </button>
                )}
                <button
                  type="button"
                  className="ghost small"
                  onClick={(event) => {
                    event.stopPropagation()
                    onEdit(server)
                  }}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="ghost small danger"
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(server)
                  }}
                >
                  Borrar
                </button>
              </div>
              {status?.state === 'error' && status.message ? (
                <p className="server-error">{status.message}</p>
              ) : null}
            </li>
          )
        })}
        {servers.length === 0 ? (
          <li className="empty-hint">Agrega tu primer servidor para empezar.</li>
        ) : null}
      </ul>
      {footer ? <div className="sidebar-footer">{footer}</div> : null}
    </aside>
  )
}
