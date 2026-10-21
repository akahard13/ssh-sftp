import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type {
  AuthChallenge,
  AuthMethod,
  ConnectionState,
  ConnectionStatus,
  HostKeyPrompt
} from '../../shared/types'
import { appendAudit, getKnownHost, getSecret, getServer } from '../store'

export interface ManagerEvents {
  status: (status: ConnectionStatus) => void
  hostkey: (prompt: HostKeyPrompt) => void
  'auth-challenge': (challenge: AuthChallenge) => void
  'terminal-data': (terminalId: string, data: string) => void
  'terminal-exit': (terminalId: string, code: number | undefined) => void
}

interface PendingAuth {
  finish: (answers: string[]) => void
  challenge: AuthChallenge
  promptCount: number
}

interface Session {
  serverId: string
  client: Client
  jumpClient: Client | null
  status: ConnectionState
  sftp: SFTPWrapper | null
  sftpPromise: Promise<SFTPWrapper> | null
  shells: Map<string, ClientChannel>
  pendingAuth: PendingAuth | null
  pendingHostKey: {
    host: string
    port: number
    fingerprint: string
    algorithm: string
    kind: 'unknown' | 'mismatch'
    previous?: string
  } | null
}

const sessions = new Map<string, Session>()
let emit: ManagerEvents | null = null

export function setManagerEvents(events: ManagerEvents | null): void {
  emit = events
}

function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

function algorithmOf(key: Buffer): string {
  if (key.length < 5) return 'unknown'
  const len = key.readUInt32BE(0)
  if (len < 1 || len > key.length - 4) return 'unknown'
  return key.subarray(4, 4 + len).toString('ascii')
}

function setStatus(serverId: string, state: ConnectionState, message?: string): void {
  const session = sessions.get(serverId)
  if (session) session.status = state
  emit?.status({ serverId, state, message })
}

function agentSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\openssh-ssh-agent'
  }
  const sock = process.env.SSH_AUTH_SOCK
  if (!sock) throw new Error('No se encontró SSH_AUTH_SOCK; inicia ssh-agent antes de conectar.')
  return sock
}

interface AuthTarget {
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath: string | null
}

function buildConfig(
  target: AuthTarget,
  secret: string | null,
  hostVerifier: (key: Buffer) => boolean,
  sock?: Duplex
): ConnectConfig {
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: 25000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
    hostVerifier
  }
  if (sock) config.sock = sock

  switch (target.authMethod) {
    case 'password':
      if (secret) config.password = secret
      break
    case 'key': {
      if (!target.privateKeyPath) {
        throw new Error('Falta la ruta de la llave privada para este servidor.')
      }
      let key: Buffer
      try {
        key = readFileSync(target.privateKeyPath)
      } catch {
        throw new Error(`No se pudo leer la llave privada: ${target.privateKeyPath}`)
      }
      config.privateKey = key
      if (secret) config.passphrase = secret
      break
    }
    case 'agent':
      config.agent = agentSocketPath()
      break
  }
  return config
}

function connectClient(client: Client, config: ConnectConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReady = (): void => {
      client.removeListener('error', onError)
      resolve()
    }
    const onError = (err: Error): void => {
      client.removeListener('ready', onReady)
      reject(err)
    }
    client.once('ready', onReady)
    client.once('error', onError)
    try {
      client.connect(config)
    } catch (err) {
      client.removeListener('ready', onReady)
      client.removeListener('error', onError)
      reject(err as Error)
    }
  })
}

function forwardOut(jump: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    jump.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) reject(err)
      else resolve(stream)
    })
  })
}

function attachKeyboardInteractive(client: Client, serverId: string): void {
  client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
    const session = sessions.get(serverId)
    const challenge: AuthChallenge = {
      challengeId: randomUUID(),
      serverId,
      prompt: prompts[0]?.prompt ?? 'Código de verificación',
      echo: prompts[0]?.echo ?? false
    }
    if (session) session.pendingAuth = { finish, challenge, promptCount: prompts.length }
    setStatus(serverId, 'needs-auth', challenge.prompt)
    emit?.['auth-challenge'](challenge)
  })
}

function hostVerifierFor(serverId: string, host: string, port: number): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const session = sessions.get(serverId)
    const fingerprint = fingerprintOf(key)
    const algorithm = algorithmOf(key)
    const known = getKnownHost(host, port)

    if (!known) {
      if (session) {
        session.pendingHostKey = { host, port, fingerprint, algorithm, kind: 'unknown' }
      }
      return false
    }
    if (known.fingerprint !== fingerprint) {
      if (session) {
        session.pendingHostKey = {
          host,
          port,
          fingerprint,
          algorithm,
          kind: 'mismatch',
          previous: known.fingerprint
        }
      }
      return false
    }
    return true
  }
}

export async function connect(serverId: string): Promise<void> {
  const profile = getServer(serverId)
  if (!profile) throw new Error('Servidor desconocido.')

  const current = sessions.get(serverId)
  if (current?.status === 'ready' || current?.status === 'connecting' || current?.status === 'needs-auth') {
    return
  }
  if (current) closeSession(current)

  const client = new Client()
  const session: Session = {
    serverId,
    client,
    jumpClient: null,
    status: 'connecting',
    sftp: null,
    sftpPromise: null,
    shells: new Map(),
    pendingAuth: null,
    pendingHostKey: null
  }
  sessions.set(serverId, session)
  setStatus(serverId, 'connecting')
  attachKeyboardInteractive(client, serverId)

  const secret = getSecret(serverId)

  try {
    let sock: Duplex | undefined
    if (profile.jumpHost) {
      const jumpClient = new Client()
      session.jumpClient = jumpClient
      attachKeyboardInteractive(jumpClient, serverId)
      const jumpConfig = buildConfig(
        profile.jumpHost as AuthTarget,
        secret,
        hostVerifierFor(serverId, profile.jumpHost.host, profile.jumpHost.port)
      )
      await connectClient(jumpClient, jumpConfig)
      sock = await forwardOut(jumpClient, profile.host, profile.port)
    }

    const config = buildConfig(
      profile as AuthTarget,
      secret,
      hostVerifierFor(serverId, profile.host, profile.port),
      sock
    )
    await connectClient(client, config)
  } catch (err) {
    const pending = session.pendingHostKey
    if (pending) {
      const prompt: HostKeyPrompt = {
        serverId,
        host: pending.host,
        port: pending.port,
        fingerprint: pending.fingerprint,
        algorithm: pending.algorithm,
        kind: pending.kind,
        previousFingerprint: pending.previous
      }
      setStatus(
        serverId,
        'error',
        pending.kind === 'mismatch'
          ? 'La llave del host cambió. Conexión bloqueada.'
          : 'Host desconocido: confirma la huella para continuar.'
      )
      emit?.hostkey(prompt)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    setStatus(serverId, 'error', message)
    void appendAudit({
      at: new Date().toISOString(),
      serverId,
      serverName: profile.name,
      action: 'connect',
      detail: `fallo: ${message}`
    })
    throw err
  }

  client.on('error', (err: Error) => {
    setStatus(serverId, 'error', err.message)
  })
  client.on('close', () => {
    if (sessions.get(serverId) === session) {
      closeSession(session, true)
    }
  })
  client.on('end', () => {
    setStatus(serverId, 'disconnected')
  })

  session.status = 'ready'
  session.pendingHostKey = null
  setStatus(serverId, 'ready')
  void appendAudit({
    at: new Date().toISOString(),
    serverId,
    serverName: profile.name,
    action: 'connect',
    detail: `${profile.username}@${profile.host}:${profile.port}`
  })
}

function closeSession(session: Session, fromRemote = false): void {
  for (const [, stream] of session.shells) {
    try {
      stream.close()
    } catch {
      /* already closed */
    }
  }
  session.shells.clear()
  session.sftp = null
  session.sftpPromise = null
  try {
    session.client.end()
  } catch {
    /* ignore */
  }
  try {
    session.jumpClient?.end()
  } catch {
    /* ignore */
  }
  if (sessions.get(session.serverId) === session) {
    sessions.delete(session.serverId)
    if (!fromRemote) setStatus(session.serverId, 'disconnected')
  }
}

export async function disconnect(serverId: string): Promise<void> {
  const session = sessions.get(serverId)
  if (!session) return
  const profile = getServer(serverId)
  closeSession(session)
  if (profile) {
    void appendAudit({
      at: new Date().toISOString(),
      serverId,
      serverName: profile.name,
      action: 'disconnect',
      detail: 'cierre manual'
    })
  }
}

export async function disconnectAll(): Promise<void> {
  for (const session of [...sessions.values()]) {
    closeSession(session)
  }
}

export function replyAuthChallenge(challengeId: string, answer: string): void {
  for (const session of sessions.values()) {
    if (session.pendingAuth?.challenge.challengeId === challengeId) {
      const { finish, promptCount } = session.pendingAuth
      session.pendingAuth = null
      // La UI pide un solo valor; se replica para servidores que envían más de un prompt.
      finish(Array.from({ length: Math.max(1, promptCount) }, () => answer))
      setStatus(session.serverId, 'connecting')
      return
    }
  }
  throw new Error('Desafío de autenticación no encontrado.')
}

export function getSession(serverId: string): Session | null {
  return sessions.get(serverId) ?? null
}

export function requireReadySession(serverId: string): Session {
  const session = sessions.get(serverId)
  if (!session || session.status !== 'ready') {
    throw new Error('El servidor no tiene una sesión activa.')
  }
  return session
}

export async function getSftp(serverId: string): Promise<SFTPWrapper> {
  const session = requireReadySession(serverId)
  if (session.sftp) return session.sftp
  if (!session.sftpPromise) {
    session.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) {
          session.sftpPromise = null
          reject(err)
          return
        }
        session.sftp = sftp
        sftp.on('close', () => {
          if (session.sftp === sftp) {
            session.sftp = null
            session.sftpPromise = null
          }
        })
        resolve(sftp)
      })
    })
  }
  return session.sftpPromise
}

export function openShell(serverId: string, cols: number, rows: number): { terminalId: string } {
  const session = requireReadySession(serverId)
  const terminalId = randomUUID()
  session.client.shell(
    { term: 'xterm-256color', cols, rows },
    (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        emit?.['terminal-exit'](terminalId, undefined)
        return
      }
      session.shells.set(terminalId, stream)
      stream.on('data', (chunk: Buffer) => emit?.['terminal-data'](terminalId, chunk.toString('utf8')))
      stream.stderr.on('data', (chunk: Buffer) => emit?.['terminal-data'](terminalId, chunk.toString('utf8')))
      stream.on('close', () => {
        session.shells.delete(terminalId)
        emit?.['terminal-exit'](terminalId, undefined)
      })
    }
  )
  return { terminalId }
}

export function writeShell(terminalId: string, data: string): void {
  for (const session of sessions.values()) {
    const stream = session.shells.get(terminalId)
    if (stream) {
      stream.write(data)
      return
    }
  }
}

export function resizeShell(terminalId: string, cols: number, rows: number): void {
  for (const session of sessions.values()) {
    const stream = session.shells.get(terminalId)
    if (stream) {
      stream.setWindow(rows, cols, 0, 0)
      return
    }
  }
}

export function closeShell(terminalId: string): void {
  for (const session of sessions.values()) {
    const stream = session.shells.get(terminalId)
    if (stream) {
      session.shells.delete(terminalId)
      try {
        stream.close()
      } catch {
        /* ignore */
      }
      return
    }
  }
}
