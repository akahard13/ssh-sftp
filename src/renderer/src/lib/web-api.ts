import type { AppApi } from '../../../shared/api'
import type {
  AuthChallenge,
  AuditEvent,
  CompareDefaults,
  CompareProgress,
  CompareResult,
  ConnectionStatus,
  FilePair,
  HostKeyPrompt,
  LocalDirListing,
  OpenTerminalResult,
  RemoteDir,
  ServerInput,
  ServerProfile,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdateState,
  UploadRequest,
  UploadResult
} from '../../../shared/types'

type Listener = (payload: unknown) => void

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RpcResult {
  type: 'rpc-result'
  id: number | null
  ok: boolean
  result?: unknown
  error?: { name?: string; message?: string }
}

interface EventMessage {
  type: 'event'
  event: string
  payload: unknown
}

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 10_000
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

function timeoutFor(method: string): number {
  if (method === 'compare:run') return 30 * 60 * 1000
  if (method === 'file:upload') return 10 * 60 * 1000
  return DEFAULT_TIMEOUT_MS
}

/**
 * Transporte del modo servidor: una conexión WebSocket para RPC y eventos.
 * Si se cae, las suscripciones sobreviven y las peticiones en vuelo se rechazan.
 */
class WebRpcClient {
  private socket: WebSocket | null = null
  private connecting = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private closed = false
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly openWaiters = new Set<() => void>()
  private readonly openRejecters = new Set<(error: Error) => void>()
  /** Eventos que llegaron antes de que React montara sus suscripciones. */
  private readonly buffered = new Map<string, unknown[]>()
  private authChecked = false

  constructor() {
    this.connect()
  }

  private endpoint(): string {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return scheme + '//' + window.location.host + '/api/ws'
  }

  private connect(): void {
    if (this.closed || this.connecting || this.socket) return
    this.connecting = true
    let socket: WebSocket
    try {
      socket = new WebSocket(this.endpoint())
    } catch {
      this.connecting = false
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      this.connecting = false
      this.attempts = 0
      this.authChecked = false
      for (const resolve of this.openWaiters) resolve()
      this.openWaiters.clear()
      this.openRejecters.clear()
    })

    socket.addEventListener('message', (event) => {
      this.handleMessage(event.data)
    })

    socket.addEventListener('error', () => {
      // El navegador emite 'close' después; el reintento vive allí.
    })

    socket.addEventListener('close', () => {
      this.connecting = false
      if (this.socket === socket) this.socket = null
      this.rejectPending('Se perdió la conexión con el servidor. Reintentando…')
      for (const reject of this.openRejecters) reject(new Error('No se pudo conectar con el servidor.'))
      this.openWaiters.clear()
      this.openRejecters.clear()
      if (this.attempts >= 1) this.checkSession()
      this.scheduleReconnect()
    })
  }

  /** Si el servidor está vivo pero la cookie ya no vale, vuelve al acceso. */
  private checkSession(): void {
    if (this.authChecked) return
    this.authChecked = true
    void fetch('/api/session', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ authenticated?: boolean }>)
      .then((session) => {
        if (session.authenticated !== false) return
        this.closed = true
        window.location.assign('/login')
      })
      .catch(() => {
        this.authChecked = false
      })
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS)
    this.attempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private waitForOpen(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('La conexión está cerrada.'))
        return
      }
      this.openWaiters.add(resolve)
      this.openRejecters.add(reject)
    })
  }

  private rejectPending(message: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(message))
      this.pending.delete(id)
    }
  }

  private handleMessage(raw: unknown): void {
    let message: RpcResult | EventMessage | { type: string }
    try {
      message = JSON.parse(String(raw)) as RpcResult | EventMessage
    } catch {
      return
    }
    if (message.type === 'rpc-result') {
      const result = message as RpcResult
      if (typeof result.id !== 'number') return
      const entry = this.pending.get(result.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(result.id)
      if (result.ok) {
        entry.resolve(result.result)
      } else {
        const error = new Error(result.error?.message ?? 'Error del servidor.')
        if (result.error?.name) error.name = result.error.name
        entry.reject(error)
      }
      return
    }
    if (message.type === 'event') {
      const event = message as EventMessage
      const handlers = this.listeners.get(event.event)
      if (!handlers || handlers.size === 0) {
        const queue = this.buffered.get(event.event) ?? []
        if (queue.length < 200) queue.push(event.payload)
        this.buffered.set(event.event, queue)
        return
      }
      for (const handler of handlers) handler(event.payload)
    }
  }

  request<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('La conexión está cerrada.'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('El servidor tardó demasiado en responder (' + method + ').'))
      }, timeoutFor(method))
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      void this.waitForOpen()
        .then(() => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'rpc', id, method, params }))
          } else {
            this.pending.delete(id)
            clearTimeout(timer)
            reject(new Error('Sin conexión con el servidor.'))
          }
        })
        .catch((err: unknown) => {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
    })
  }

  subscribe(event: string, handler: Listener): () => void {
    let handlers = this.listeners.get(event)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(event, handlers)
    }
    handlers.add(handler)
    const queued = this.buffered.get(event)
    if (queued) {
      this.buffered.delete(event)
      for (const payload of queued) handler(payload)
    }
    return () => {
      const current = this.listeners.get(event)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) this.listeners.delete(event)
    }
  }
}

interface HttpRpcEnvelope {
  ok: boolean
  result?: unknown
  error?: { name?: string; message?: string }
}

/**
 * Las subidas pueden pesar varios MB y superar el límite de un frame WebSocket,
 * así que viajan por HTTP. El resto del tráfico interactivo usa el WebSocket.
 */
async function httpRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params })
  })
  if (response.status === 401) {
    window.location.assign('/login')
    throw new Error('La sesión expiró. Vuelve a iniciar sesión.')
  }
  let payload: HttpRpcEnvelope
  try {
    payload = (await response.json()) as HttpRpcEnvelope
  } catch {
    throw new Error('El servidor devolvió una respuesta no válida (' + response.status + ').')
  }
  if (!payload.ok) {
    const error = new Error(payload.error?.message ?? 'Error del servidor.')
    if (payload.error?.name) error.name = payload.error.name
    throw error
  }
  return payload.result as T
}

export function createWebApi(): AppApi {
  const client = new WebRpcClient()
  const call = <T>(method: string, ...params: unknown[]): Promise<T> =>
    client.request<T>(method, params)
  const unavailable = (): Promise<null> =>
    Promise.reject(new Error('Los diálogos nativos solo existen en la app de escritorio. Usa el explorador de rutas.'))

  return {
    platform: 'web',
    servers: {
      list: () => call<ServerProfile[]>('servers:list'),
      save: (input: ServerInput) => call<ServerProfile>('servers:save', input),
      remove: (serverId: string) => call<boolean>('servers:delete', serverId)
    },
    audit: {
      list: () => call<AuditEvent[]>('audit:list')
    },
    connection: {
      connect: (serverId: string) => call<boolean>('conn:connect', serverId),
      disconnect: (serverId: string) => call<boolean>('conn:disconnect', serverId),
      onStatus: (handler: (status: ConnectionStatus) => void) =>
        client.subscribe('evt:conn-status', handler as Listener),
      onHostKey: (handler: (prompt: HostKeyPrompt) => void) =>
        client.subscribe('evt:hostkey', handler as Listener),
      onAuthChallenge: (handler: (challenge: AuthChallenge) => void) =>
        client.subscribe('evt:auth-challenge', handler as Listener),
      respondAuth: (challengeId: string, answer: string) =>
        call<boolean>('auth:respond', challengeId, answer)
    },
    hostKey: {
      trust: (serverId, fingerprint, algorithm, host, port) =>
        call<boolean>('hostkey:trust', serverId, fingerprint, algorithm, host, port)
    },
    terminal: {
      open: (serverId: string, cols: number, rows: number) =>
        call<OpenTerminalResult>('term:open', serverId, cols, rows),
      write: (terminalId: string, data: string) =>
        call<boolean>('term:write', terminalId, data).catch(() => false),
      resize: (terminalId: string, cols: number, rows: number) =>
        call<boolean>('term:resize', terminalId, cols, rows).catch(() => false),
      close: (terminalId: string) => call<boolean>('term:close', terminalId).catch(() => false),
      onData: (handler: (event: TerminalDataEvent) => void) =>
        client.subscribe('evt:term-data', handler as Listener),
      onExit: (handler: (event: TerminalExitEvent) => void) =>
        client.subscribe('evt:term-exit', handler as Listener)
    },
    local: {
      pickDirectory: unavailable,
      pickFile: unavailable,
      listDirectories: (path: string | null) =>
        call<LocalDirListing>('local:list-dirs', path)
    },
    remote: {
      listDirectories: (serverId: string, path: string) =>
        call<RemoteDir[]>('remote:list-dirs', serverId, path)
    },
    compare: {
      defaults: () => call<CompareDefaults>('compare:defaults'),
      saveExcludes: (patterns: string[]) =>
        call<boolean>('compare:save-excludes', patterns),
      run: (requestId, serverId, remoteRoot, localRoot, excluded) =>
        call<CompareResult | null>(
          'compare:run',
          requestId,
          serverId,
          remoteRoot,
          localRoot,
          excluded
        ),
      cancel: (requestId: string) => call<boolean>('compare:cancel', requestId),
      onProgress: (handler: (progress: CompareProgress) => void) =>
        client.subscribe('evt:compare-progress', handler as Listener)
    },
    files: {
      readPair: (serverId, remoteRoot, localRoot, relPath) =>
        call<FilePair>('file:read-pair', serverId, remoteRoot, localRoot, relPath),
      upload: (request: UploadRequest) => httpRpc<UploadResult>('file:upload', [request])
    },
    updates: {
      state: () => call<UpdateState>('updates:state'),
      check: () => call<UpdateState>('updates:check'),
      download: () => call<UpdateState>('updates:download'),
      install: () => call<boolean>('updates:install'),
      onState: (handler: (state: UpdateState) => void) =>
        client.subscribe('evt:update-state', handler as Listener)
    }
  }
}
