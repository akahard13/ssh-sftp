import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AuthMethod, ServerInput, ServerProfile } from '../../../shared/types'
import { api } from '../lib/api'
import LocalPathBrowser from './LocalPathBrowser'
import Modal from './Modal'

interface ServerDialogProps {
  profile: ServerProfile | null
  onClose: () => void
  onSaved: (profile: ServerProfile) => void
}

interface FormState {
  name: string
  host: string
  port: string
  username: string
  authMethod: AuthMethod
  privateKeyPath: string
  remoteRoot: string
  localRoot: string
  secret: string
  hasSecret: boolean
  clearSecret: boolean
  useJump: boolean
  jumpHost: string
  jumpPort: string
  jumpUsername: string
  jumpAuthMethod: AuthMethod
  jumpPrivateKeyPath: string
}

function initialState(profile: ServerProfile | null): FormState {
  return {
    name: profile?.name ?? '',
    host: profile?.host ?? '',
    port: String(profile?.port ?? 22),
    username: profile?.username ?? '',
    authMethod: profile?.authMethod ?? 'key',
    privateKeyPath: profile?.privateKeyPath ?? '',
    remoteRoot: profile?.remoteRoot ?? '',
    localRoot: profile?.localRoot ?? '',
    secret: '',
    hasSecret: profile?.hasSecret ?? false,
    clearSecret: false,
    useJump: Boolean(profile?.jumpHost),
    jumpHost: profile?.jumpHost?.host ?? '',
    jumpPort: String(profile?.jumpHost?.port ?? 22),
    jumpUsername: profile?.jumpHost?.username ?? '',
    jumpAuthMethod: profile?.jumpHost?.authMethod ?? 'agent',
    jumpPrivateKeyPath: profile?.jumpHost?.privateKeyPath ?? ''
  }
}

export default function ServerDialog({ profile, onClose, onSaved }: ServerDialogProps): JSX.Element {
  const [form, setForm] = useState<FormState>(() => initialState(profile))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyBrowserOpen, setKeyBrowserOpen] = useState(false)
  const [localBrowserOpen, setLocalBrowserOpen] = useState(false)

  useEffect(() => {
    setForm(initialState(profile))
  }, [profile])

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const secretLabel =
    form.authMethod === 'password'
      ? 'Contraseña'
      : form.authMethod === 'key'
        ? 'Passphrase de la llave (opcional)'
        : null

  const submit = async (): Promise<void> => {
    setError(null)
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError('Nombre, host y usuario son obligatorios.')
      return
    }
    const port = Number(form.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('El puerto debe ser un número entre 1 y 65535.')
      return
    }
    const jumpPort = Number(form.jumpPort)
    if (form.useJump) {
      if (!form.jumpHost.trim() || !form.jumpUsername.trim()) {
        setError('El bastión requiere host y usuario.')
        return
      }
      if (!Number.isInteger(jumpPort) || jumpPort < 1 || jumpPort > 65535) {
        setError('El puerto del bastión es inválido.')
        return
      }
    }

    const input: ServerInput = {
      id: profile?.id,
      name: form.name,
      host: form.host,
      port,
      username: form.username,
      authMethod: form.authMethod,
      privateKeyPath: form.privateKeyPath || null,
      remoteRoot: form.remoteRoot || null,
      localRoot: form.localRoot || null,
      jumpHost: form.useJump
        ? {
            host: form.jumpHost,
            port: jumpPort,
            username: form.jumpUsername,
            authMethod: form.jumpAuthMethod,
            privateKeyPath: form.jumpPrivateKeyPath || null
          }
        : null,
      secret: form.secret.length > 0 ? form.secret : undefined,
      clearSecret: form.clearSecret || undefined
    }

    setSaving(true)
    try {
      const saved = await api.servers.save(input)
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el servidor.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Modal
        title={profile ? 'Editar servidor' : 'Nuevo servidor'}
        onClose={onClose}
        width={640}
        footer={
          <>
            <button type="button" className="ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="primary" onClick={submit} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <label>
            Nombre
            <input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Producción web" />
          </label>
          <label>
            Host
            <input value={form.host} onChange={(e) => update('host', e.target.value)} placeholder="10.0.0.15" />
          </label>
          <label>
            Puerto
            <input value={form.port} onChange={(e) => update('port', e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Usuario
            <input value={form.username} onChange={(e) => update('username', e.target.value)} placeholder="deploy" />
          </label>
          <label>
            Autenticación
            <select
              value={form.authMethod}
              onChange={(e) => update('authMethod', e.target.value as AuthMethod)}
            >
              <option value="key">Llave privada</option>
              <option value="agent">ssh-agent</option>
              <option value="password">Contraseña</option>
            </select>
          </label>
          {form.authMethod === 'key' ? (
            <label className="span-2">
              Ruta de la llave privada
              <div className="input-row">
                <input
                  value={form.privateKeyPath}
                  onChange={(e) => update('privateKeyPath', e.target.value)}
                  placeholder="C:\Users\tu-usuario\.ssh\id_ed25519"
                />
                <button
                  type="button"
                  className="ghost"
                  onClick={async () => {
                    if (api.platform === 'web') {
                      setKeyBrowserOpen(true)
                      return
                    }
                    const picked = await api.local.pickFile()
                    if (picked) update('privateKeyPath', picked)
                  }}
                >
                  Buscar…
                </button>
              </div>
            </label>
          ) : null}
          {secretLabel ? (
            <label className="span-2">
              {secretLabel}
              <div className="input-row">
                <input
                  type="password"
                  value={form.secret}
                  onChange={(e) => update('secret', e.target.value)}
                  placeholder={form.hasSecret ? '•••••••• (guardada, escribe para reemplazar)' : ''}
                  autoComplete="new-password"
                />
                {form.hasSecret ? (
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={() => {
                      update('clearSecret', true)
                      update('hasSecret', false)
                    }}
                  >
                    Borrar guardada
                  </button>
                ) : null}
              </div>
              {form.clearSecret ? <span className="hint">Se eliminará el secreto guardado.</span> : null}
            </label>
          ) : null}
          <label>
            Directorio remoto base
            <input
              value={form.remoteRoot}
              onChange={(e) => update('remoteRoot', e.target.value)}
              placeholder="/var/www/app"
            />
          </label>
          <label>
            Directorio local base
            <div className="input-row">
              <input
                value={form.localRoot}
                onChange={(e) => update('localRoot', e.target.value)}
                placeholder="C:\proyectos\app"
              />
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  if (api.platform === 'web') {
                    setLocalBrowserOpen(true)
                    return
                  }
                  const picked = await api.local.pickDirectory()
                  if (picked) update('localRoot', picked)
                }}
              >
                {api.platform === 'web' ? 'Explorar…' : 'Elegir…'}
              </button>
            </div>
          </label>
        </div>

        <div className="section">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.useJump}
              onChange={(e) => update('useJump', e.target.checked)}
            />
            Conectar a través de un bastión (ProxyJump)
          </label>
          {form.useJump ? (
            <div className="form-grid section">
              <label>
                Host del bastión
                <input value={form.jumpHost} onChange={(e) => update('jumpHost', e.target.value)} />
              </label>
              <label>
                Puerto
                <input value={form.jumpPort} onChange={(e) => update('jumpPort', e.target.value)} inputMode="numeric" />
              </label>
              <label>
                Usuario
                <input value={form.jumpUsername} onChange={(e) => update('jumpUsername', e.target.value)} />
              </label>
              <label>
                Autenticación
                <select
                  value={form.jumpAuthMethod}
                  onChange={(e) => update('jumpAuthMethod', e.target.value as AuthMethod)}
                >
                  <option value="agent">ssh-agent</option>
                  <option value="key">Llave privada</option>
                  <option value="password">Contraseña</option>
                </select>
              </label>
              {form.jumpAuthMethod === 'key' ? (
                <label className="span-2">
                  Llave del bastión
                  <input
                    value={form.jumpPrivateKeyPath}
                    onChange={(e) => update('jumpPrivateKeyPath', e.target.value)}
                  />
                </label>
              ) : null}
              <p className="hint span-2">
                El bastión usa el mismo secreto guardado para este servidor.
              </p>
            </div>
          ) : null}
        </div>

        {error ? <p className="error-banner">{error}</p> : null}
      </Modal>

      {keyBrowserOpen ? (
        <LocalPathBrowser
          mode="file"
          initialPath={form.privateKeyPath}
          title="Elegir llave privada en el equipo del servicio"
          onClose={() => setKeyBrowserOpen(false)}
          onPick={(picked) => {
            update('privateKeyPath', picked)
            setKeyBrowserOpen(false)
          }}
        />
      ) : null}

      {localBrowserOpen ? (
        <LocalPathBrowser
          mode="directory"
          initialPath={form.localRoot}
          title="Elegir carpeta en el equipo del servicio"
          onClose={() => setLocalBrowserOpen(false)}
          onPick={(picked) => {
            update('localRoot', picked)
            setLocalBrowserOpen(false)
          }}
        />
      ) : null}
    </>
  )
}
