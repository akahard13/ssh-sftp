import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type {
  AuthChallenge,
  ConnectionStatus,
  HostKeyPrompt,
  ServerProfile
} from '../../shared/types'
import CompareView from './components/CompareView'
import Modal from './components/Modal'
import ServerDialog from './components/ServerDialog'
import ServerSidebar from './components/ServerSidebar'
import TerminalView from './components/TerminalView'
import UpdatePanel from './components/UpdatePanel'

type Tab = 'terminal' | 'compare'

export default function App(): JSX.Element {
  const [servers, setServers] = useState<ServerProfile[]>([])
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('terminal')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ServerProfile | null>(null)
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null)
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null)
  const [answer, setAnswer] = useState('')
  const [banner, setBanner] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.servers.list()
      setServers(list)
      setActiveId((current) => current ?? list[0]?.id ?? null)
    } catch (err) {
      setBanner(err instanceof Error ? err.message : 'No se pudo cargar la lista de servidores.')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offStatus = window.api.connection.onStatus((status) => {
      setStatuses((prev) => ({ ...prev, [status.serverId]: status }))
    })
    const offHostKey = window.api.connection.onHostKey((prompt) => setHostKey(prompt))
    const offAuth = window.api.connection.onAuthChallenge((incoming) => {
      setChallenge(incoming)
      setAnswer('')
    })
    return () => {
      offStatus()
      offHostKey()
      offAuth()
    }
  }, [refresh])

  const active = servers.find((server) => server.id === activeId) ?? null
  const activeStatus = active ? statuses[active.id] : undefined
  const ready = activeStatus?.state === 'ready'

  const notify = (err: unknown, fallback: string): void => {
    setBanner(err instanceof Error ? err.message : fallback)
  }

  const connect = async (id: string): Promise<void> => {
    setBanner(null)
    try {
      await window.api.connection.connect(id)
    } catch (err) {
      notify(err, 'No se pudo conectar.')
    }
  }

  const disconnect = async (id: string): Promise<void> => {
    setBanner(null)
    try {
      await window.api.connection.disconnect(id)
    } catch (err) {
      notify(err, 'No se pudo desconectar.')
    }
  }

  const openNew = (): void => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (profile: ServerProfile): void => {
    setEditing(profile)
    setDialogOpen(true)
  }

  const remove = async (profile: ServerProfile): Promise<void> => {
    if (!window.confirm(`¿Eliminar el servidor "${profile.name}"? Se borrarán sus datos guardados.`)) {
      return
    }
    setBanner(null)
    try {
      await window.api.servers.remove(profile.id)
      if (activeId === profile.id) setActiveId(null)
      await refresh()
    } catch (err) {
      notify(err, 'No se pudo eliminar el servidor.')
    }
  }

  return (
    <div className="app">
      <ServerSidebar
        servers={servers}
        statuses={statuses}
        activeId={activeId}
        onSelect={setActiveId}
        onAdd={openNew}
        onEdit={openEdit}
        onDelete={(profile) => void remove(profile)}
        onConnect={(id) => void connect(id)}
        onDisconnect={(id) => void disconnect(id)}
        footer={<UpdatePanel />}
      />

      <main className="content">
        {banner ? (
          <div className="banner">
            <span>{banner}</span>
            <button type="button" className="ghost small" onClick={() => setBanner(null)}>
              Cerrar
            </button>
          </div>
        ) : null}

        {!active ? (
          <div className="placeholder">
            <h1>Sin servidor seleccionado</h1>
            <p>Agrega un servidor para abrir una sesión SSH o comparar directorios por SFTP.</p>
          </div>
        ) : (
          <>
            <header className="topbar">
              <div className="topbar-title">
                <strong>{active.name}</strong>
                <span className="muted">
                  {active.username}@{active.host}:{active.port}
                </span>
                <span className={`badge ${activeStatus?.state ?? 'disconnected'}`}>
                  {activeStatus?.state === 'ready'
                    ? 'conectado'
                    : activeStatus?.state === 'connecting'
                      ? 'conectando…'
                      : activeStatus?.state === 'needs-auth'
                        ? 'esperando código'
                        : activeStatus?.state === 'error'
                          ? 'error'
                          : 'desconectado'}
                </span>
              </div>
              <div className="tabs">
                <button
                  type="button"
                  className={`tab ${tab === 'terminal' ? 'active' : ''}`}
                  onClick={() => setTab('terminal')}
                >
                  Terminal
                </button>
                <button
                  type="button"
                  className={`tab ${tab === 'compare' ? 'active' : ''}`}
                  onClick={() => setTab('compare')}
                >
                  Comparar / Subir
                </button>
              </div>
              {ready ? null : (
                <button type="button" className="primary small" onClick={() => void connect(active.id)}>
                  Conectar
                </button>
              )}
            </header>

            <section className="workspace">
              {!ready ? (
                <div className="placeholder">
                  <h1>
                    {activeStatus?.state === 'error' ? 'No se pudo conectar' : 'Sesión no iniciada'}
                  </h1>
                  <p>{activeStatus?.message ?? 'Conecta el servidor para usar la terminal y SFTP.'}</p>
                  <button type="button" className="primary" onClick={() => void connect(active.id)}>
                    Conectar
                  </button>
                </div>
              ) : tab === 'terminal' ? (
                <TerminalView serverId={active.id} visible />
              ) : (
                <CompareView profile={active} />
              )}
            </section>
          </>
        )}
      </main>

      {dialogOpen ? (
        <ServerDialog
          profile={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={async () => {
            setDialogOpen(false)
            await refresh()
          }}
        />
      ) : null}

      {hostKey ? (
        <Modal
          title={hostKey.kind === 'mismatch' ? '¡La llave del host cambió!' : 'Host desconocido'}
          width={560}
          footer={
            <>
              <button type="button" className="ghost" onClick={() => setHostKey(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className={hostKey.kind === 'mismatch' ? 'danger-solid' : 'primary'}
                onClick={async () => {
                  const prompt = hostKey
                  setHostKey(null)
                  try {
                    await window.api.hostKey.trust(
                      prompt.serverId,
                      prompt.fingerprint,
                      prompt.algorithm,
                      prompt.host,
                      prompt.port
                    )
                  } catch (err) {
                    notify(err, 'No se pudo guardar la huella.')
                  }
                }}
              >
                Confiar y conectar
              </button>
            </>
          }
        >
          <p>
            {hostKey.kind === 'mismatch'
              ? 'La huella del servidor no coincide con la guardada. Esto puede indicar un ataque de intermediario o una reinstalación del servidor. Verifica la huella por un canal confiable antes de continuar.'
              : 'Es la primera conexión a este host. Verifica la huella con el administrador del servidor antes de confiar.'}
          </p>
          <dl className="fingerprint">
            <dt>Host</dt>
            <dd>
              {hostKey.host}:{hostKey.port}
            </dd>
            <dt>Algoritmo</dt>
            <dd>{hostKey.algorithm}</dd>
            <dt>Huella</dt>
            <dd>
              <code>{hostKey.fingerprint}</code>
            </dd>
            {hostKey.previousFingerprint ? (
              <>
                <dt>Guardada</dt>
                <dd>
                  <code>{hostKey.previousFingerprint}</code>
                </dd>
              </>
            ) : null}
          </dl>
        </Modal>
      ) : null}

      {challenge ? (
        <Modal
          title="Autenticación adicional"
          width={420}
          footer={
            <>
              <button type="button" className="ghost" onClick={() => setChallenge(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  const current = challenge
                  setChallenge(null)
                  try {
                    await window.api.connection.respondAuth(current.challengeId, answer)
                  } catch (err) {
                    notify(err, 'No se pudo enviar la respuesta.')
                  }
                }}
              >
                Enviar
              </button>
            </>
          }
        >
          <p>{challenge.prompt}</p>
          <input
            className="full"
            type={challenge.echo ? 'text' : 'password'}
            value={answer}
            autoFocus
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const current = challenge
                setChallenge(null)
                void window.api.connection.respondAuth(current.challengeId, answer)
              }
            }}
          />
        </Modal>
      ) : null}
    </div>
  )
}
