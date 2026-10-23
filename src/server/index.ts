import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { UpdateState } from '../shared/types'
import {
  disposeServices,
  getConnectionStatuses,
  getPendingPrompts,
  initServices,
  invokeCore
} from '../main/services'
import {
  clearSessionCookie,
  isAuthenticated,
  LoginRateLimiter,
  originMatchesHost,
  safeEqual,
  sessionCookie,
  sessionValue
} from './auth'
import { MIN_TOKEN_LENGTH } from './args'
import { createServerSecretCodec, ensureDataDir, loadOrCreateToken } from './paths'

const MAX_LOGIN_BODY = 8 * 1024
const MAX_RPC_BODY = 96 * 1024 * 1024
const WS_MAX_PAYLOAD = 1024 * 1024
const WS_MAX_BUFFERED = 16 * 1024 * 1024
const WS_PING_INTERVAL_MS = 30_000
const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000
const LOGIN_RATE_MAX = 10

const APP_CSP_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

/** 'self' no cubre el esquema ws en todos los navegadores; se añade el host real. */
function appCsp(req: IncomingMessage): string {
  const host = req.headers.host
  const ws = host && /^[A-Za-z0-9.\-:\[\]]+$/.test(host) ? ' ws://' + host + ' wss://' + host : ''
  return APP_CSP_BASE + "; connect-src 'self'" + ws + ';'
}
const LOGIN_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

export interface TlsFiles {
  cert: Buffer
  key: Buffer
}

export interface StartServerOptions {
  dataDir: string
  webDir: string
  host?: string
  port?: number
  token?: string
  version?: string
  tls?: TlsFiles | null
  trustProxy?: boolean
  log?: (message: string) => void
}

export interface RunningServer {
  server: Server
  host: string
  port: number
  version: string
  token: string
  urls: string[]
  accessUrls: string[]
  close(): Promise<void>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

interface RpcRequest {
  type: 'rpc'
  id: number | string
  method: string
  params?: unknown[]
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function requestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? 'localhost'
  try {
    return new URL(req.url ?? '/', 'http://' + host)
  } catch {
    return new URL('http://localhost/')
  }
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

function contentLength(req: IncomingMessage): number {
  const raw = Number(req.headers['content-length'])
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, 'El cuerpo de la petición es demasiado grande.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function jsonBody(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new HttpError(400, 'El cuerpo JSON no es válido.')
  }
}

function updateStub(version: string): UpdateState {
  return {
    status: 'unsupported',
    currentVersion: version,
    message: 'Modo servidor: actualiza con "npm install -g ssh-sftp-manager@latest".'
  }
}

function handleUpdates(method: string, version: string): unknown {
  switch (method) {
    case 'updates:state':
    case 'updates:check':
    case 'updates:download':
      return updateStub(version)
    case 'updates:install':
      return false
    default:
      throw new Error('Método de actualización desconocido.')
  }
}

function loginPage(error: string | null): string {
  const message = error
    ? '<p class="error" role="alert">' + escapeHtml(error) + '</p>'
    : '<p class="hint">El token aparece en la consola del servidor o en &lt;data-dir&gt;/server-token.</p>'
  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<meta name="referrer" content="no-referrer" />',
    '<title>SSH · SFTP Manager — Acceso</title>',
    '<style>',
    ':root { color-scheme: dark; }',
    '* { box-sizing: border-box; }',
    'body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1319; color: #d6dae2; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }',
    '.card { width: min(92vw, 420px); padding: 32px; border: 1px solid #263041; border-radius: 12px; background: #151b24; box-shadow: 0 18px 50px rgba(0,0,0,.35); }',
    'h1 { margin: 0 0 6px; font-size: 20px; }',
    'p { margin: 0 0 18px; line-height: 1.5; color: #9aa7ba; font-size: 14px; }',
    'label { display: block; margin-bottom: 8px; font-size: 13px; color: #c8d1de; }',
    'input { width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid #334155; background: #0d1117; color: #e6edf3; font-size: 14px; }',
    'input:focus { outline: 2px solid #2f81f7; outline-offset: 1px; }',
    'button { width: 100%; margin-top: 16px; padding: 11px 14px; border: 0; border-radius: 8px; background: #2f81f7; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }',
    'button:hover { background: #4c94ff; }',
    '.error { color: #ff7b72; background: rgba(255,123,114,.1); border: 1px solid rgba(255,123,114,.25); padding: 10px 12px; border-radius: 8px; }',
    '.hint { font-size: 12px; }',
    '</style>',
    '</head>',
    '<body>',
    '<main class="card">',
    '<h1>SSH · SFTP Manager</h1>',
    '<p>Servidor web. Introduce el token de acceso para continuar.</p>',
    message,
    '<form method="post" action="/api/login">',
    '<label for="token">Token de acceso</label>',
    '<input id="token" name="token" type="password" autocomplete="current-password" autofocus required />',
    '<button type="submit">Entrar</button>',
    '</form>',
    '</main>',
    '</body>',
    '</html>'
  ].join('\n')
}

function baseSecurityHeaders(res: ServerResponse, csp: string, secure: boolean): void {
  res.setHeader('Content-Security-Policy', csp)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000')
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

function listUrls(host: string, port: number, secure: boolean): string[] {
  const scheme = secure ? 'https' : 'http'
  const urls: string[] = []
  const add = (value: string): void => {
    if (!urls.includes(value)) urls.push(value)
  }
  const hostPort = (address: string): string => address.includes(':') ? '[' + address + ']:' + port : address + ':' + port

  if (host === '0.0.0.0' || host === '::' || host === '*') {
    add(scheme + '://127.0.0.1:' + port)
    if (host !== '::') add(scheme + '://localhost:' + port)
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === 'IPv4' && !address.internal) add(scheme + '://' + hostPort(address.address))
      }
    }
  } else if (host === 'localhost') {
    add(scheme + '://localhost:' + port)
  } else {
    add(scheme + '://' + hostPort(host))
  }
  return urls
}

function accessUrl(base: string, token: string): string {
  return base + '/?token=' + encodeURIComponent(token)
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 7777
  const version = options.version ?? '0.0.0'
  const dataDir = resolve(options.dataDir)
  const webDir = resolve(options.webDir)
  const log = options.log ?? (() => {})

  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error(
      'No se encontró ' + join(webDir, 'index.html') + '. Ejecuta "npm run build:web" antes de arrancar el servidor.'
    )
  }

  ensureDataDir(dataDir)
  const token = options.token ?? loadOrCreateToken(dataDir, MIN_TOKEN_LENGTH)
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error('El token debe tener al menos ' + MIN_TOKEN_LENGTH + ' caracteres.')
  }

  const clients = new Set<WebSocket>()
  const limiter = new LoginRateLimiter(LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_MS)

  const broadcast = (event: string, payload: unknown): void => {
    if (clients.size === 0) return
    const message = JSON.stringify({ type: 'event', event, payload })
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      if (client.bufferedAmount > WS_MAX_BUFFERED) {
        clients.delete(client)
        client.terminate()
        continue
      }
      try {
        client.send(message)
      } catch {
        clients.delete(client)
      }
    }
  }

  await initServices({
    dataDir,
    secrets: createServerSecretCodec(dataDir),
    emitter: broadcast
  })

  const secureFor = (req: IncomingMessage): boolean => {
    if (options.tls) return true
    if (!options.trustProxy) return false
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase()
    return proto === 'https'
  }

  const clientIp = (req: IncomingMessage): string => {
    if (options.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
      if (forwarded) return forwarded
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  const invokeRpc = async (method: string, params: unknown[]): Promise<unknown> => {
    return method.startsWith('updates:') ? handleUpdates(method, version) : invokeCore(method, params)
  }

  const serveFile = async (
    req: IncomingMessage,
    res: ServerResponse,
    file: string,
    cacheControl: string
  ): Promise<boolean> => {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return false
    res.setHeader('Content-Type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
    res.setHeader('Content-Length', info.size)
    res.setHeader('Cache-Control', cacheControl)
    res.statusCode = 200
    if (req.method === 'HEAD') {
      res.end()
      return true
    }
    await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(file)
      stream.on('error', rejectStream)
      stream.on('end', resolveStream)
      stream.pipe(res)
    })
    return true
  }

  const serveIndex = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const served = await serveFile(req, res, join(webDir, 'index.html'), 'no-store')
    if (!served) sendText(res, 404, 'No se encontró el renderer compilado.')
  }

  const sendLogin = (
    res: ServerResponse,
    status: number,
    error: string | null,
    secure: boolean
  ): void => {
    baseSecurityHeaders(res, LOGIN_CSP, secure)
    const body = loginPage(error)
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    })
    res.end(body)
  }

  const handleLogin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!originMatchesHost(req)) {
      sendJson(res, 403, { ok: false, error: { message: 'Origen no permitido.' } })
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    const isJson = contentType.includes('application/json')
    const isForm = contentType.includes('application/x-www-form-urlencoded')
    if (!isJson && !isForm) {
      sendJson(res, 415, { ok: false, error: { message: 'Usa application/json o form-urlencoded.' } })
      return
    }

    const ip = clientIp(req)
    if (!limiter.allowed(ip)) {
      const retry = limiter.retryAfterSeconds(ip)
      res.setHeader('Retry-After', retry)
      if (isForm) sendLogin(res, 429, 'Demasiados intentos. Espera unos minutos.', secureFor(req))
      else sendJson(res, 429, { ok: false, error: { message: 'Demasiados intentos. Espera ' + retry + ' s.' } })
      return
    }

    const body = await readBody(req, MAX_LOGIN_BODY)
    let submitted = ''
    try {
      if (isJson) {
        const parsed = jsonBody(body)
        if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { token?: unknown }).token === 'string') {
          submitted = (parsed as { token: string }).token
        }
      } else {
        submitted = new URLSearchParams(body.toString('utf8')).get('token') ?? ''
      }
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { ok: false, error: { message: err.message } })
        return
      }
      throw err
    }

    if (!safeEqual(submitted, token)) {
      limiter.fail(ip)
      if (isForm) {
        res.writeHead(303, { Location: '/login?error=1', 'Cache-Control': 'no-store' })
        res.end()
      } else {
        sendJson(res, 401, { ok: false, error: { message: 'Token incorrecto.' } })
      }
      return
    }

    limiter.success(ip)
    const secure = secureFor(req)
    res.setHeader('Set-Cookie', sessionCookie(sessionValue(token), secure))
    if (isForm) {
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' })
      res.end()
    } else {
      sendJson(res, 200, { ok: true })
    }
  }

  const handleRpc = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!originMatchesHost(req)) {
      sendJson(res, 403, { ok: false, error: { message: 'Origen no permitido.' } })
      return
    }
    if (contentLength(req) > MAX_RPC_BODY) {
      sendJson(res, 413, { ok: false, error: { message: 'El cuerpo de la petición es demasiado grande.' } })
      return
    }
    const body = await readBody(req, MAX_RPC_BODY)
    let parsed: unknown
    try {
      parsed = jsonBody(body)
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 400, {
        ok: false,
        error: { message: describeError(err) }
      })
      return
    }
    const request = parsed as { method?: unknown; params?: unknown }
    if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
      sendJson(res, 400, { ok: false, error: { message: 'Falta el método RPC.' } })
      return
    }
    const params = Array.isArray(request.params) ? request.params : []
    try {
      const result = await invokeRpc(request.method, params)
      sendJson(res, 200, { ok: true, result })
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        error: { name: err instanceof Error ? err.name : 'Error', message: describeError(err) }
      })
    }
  }

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const secure = secureFor(req)
    baseSecurityHeaders(res, appCsp(req), secure)
    res.setHeader('Cache-Control', 'no-store')

    const url = requestUrl(req)
    const method = req.method ?? 'GET'
    const pathname = url.pathname

    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      sendText(res, 405, 'Método no permitido.')
      return
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' })
      res.end()
      return
    }

    if (pathname === '/api/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'Método no permitido.')
        return
      }
      sendJson(res, 200, { ok: true, version })
      return
    }

    if (pathname === '/api/session') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'Método no permitido.')
        return
      }
      sendJson(res, 200, {
        authenticated: isAuthenticated(req, token),
        version,
        platform: 'web'
      })
      return
    }

    if (pathname === '/api/login' && method === 'POST') {
      await handleLogin(req, res)
      return
    }

    if (pathname === '/api/login') {
      sendText(res, 405, 'Método no permitido.')
      return
    }

    if (pathname === '/api/logout' && method === 'POST') {
      if (!originMatchesHost(req)) {
        sendJson(res, 403, { ok: false, error: { message: 'Origen no permitido.' } })
        return
      }
      res.setHeader('Set-Cookie', clearSessionCookie(secure))
      sendJson(res, 200, { ok: true })
      return
    }

    const queryToken = url.searchParams.get('token')
    if (queryToken !== null && (method === 'GET' || method === 'HEAD')) {
      const ip = clientIp(req)
      if (!limiter.allowed(ip)) {
        const retry = limiter.retryAfterSeconds(ip)
        res.setHeader('Retry-After', retry)
        if (wantsHtml(req)) sendLogin(res, 429, 'Demasiados intentos. Espera unos minutos.', secure)
        else sendJson(res, 429, { ok: false, error: { message: 'Demasiados intentos. Espera ' + retry + ' s.' } })
        return
      }
      if (!safeEqual(queryToken, token)) {
        limiter.fail(ip)
        if (wantsHtml(req)) sendLogin(res, 401, 'El token del enlace no es válido.', secure)
        else sendJson(res, 401, { ok: false, error: { message: 'Token incorrecto.' } })
        return
      }
      limiter.success(ip)
      const params = new URLSearchParams(url.search)
      params.delete('token')
      const query = params.toString()
      const location = pathname + (query ? '?' + query : '')
      res.setHeader('Set-Cookie', sessionCookie(sessionValue(token), secure))
      res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' })
      res.end()
      return
    }

    if (pathname === '/login') {
      if (isAuthenticated(req, token)) {
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      sendLogin(
        res,
        200,
        url.searchParams.get('error') ? 'Token incorrecto. Inténtalo de nuevo.' : null,
        secure
      )
      return
    }

    if (pathname === '/api/rpc') {
      if (method !== 'POST') {
        sendText(res, 405, 'Método no permitido.')
        return
      }
      if (!isAuthenticated(req, token)) {
        sendJson(res, 401, { ok: false, error: { message: 'No autenticado.' } })
        return
      }
      await handleRpc(req, res)
      return
    }

    if (pathname === '/api/ws') {
      sendText(res, 426, 'Actualiza a WebSocket para usar este endpoint.')
      return
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: { message: 'Ruta de API desconocida.' } })
      return
    }

    if (!isAuthenticated(req, token)) {
      if (wantsHtml(req) && pathname === '/') {
        sendLogin(res, 200, null, secure)
        return
      }
      if (wantsHtml(req)) {
        res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      sendJson(res, 401, { ok: false, error: { message: 'No autenticado.' } })
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      await serveIndex(req, res)
      return
    }

    let relative: string
    try {
      relative = decodeURIComponent(pathname).replace(/^[/\\]+/, '')
    } catch {
      sendText(res, 400, 'Ruta no válida.')
      return
    }
    const target = resolve(webDir, relative)
    const root = resolve(webDir)
    if (target !== root && !target.startsWith(root + sep)) {
      sendText(res, 404, 'No encontrado.')
      return
    }
    const cache = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    const served = await serveFile(req, res, target, cache)
    if (!served) sendText(res, 404, 'No encontrado.')
  }

  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    void handleHttp(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { ok: false, error: { message: err.message } })
        else res.destroy()
        return
      }
      log('[http] ' + describeError(err))
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { message: 'Error interno del servidor.' } })
      } else {
        res.destroy()
      }
    })
  }

  const server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, requestListener)
    : createHttpServer(requestListener)

  server.headersTimeout = 60_000
  server.requestTimeout = 10 * 60_000
  server.keepAliveTimeout = 65_000

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })
  wss.on('error', (err) => log('[ws] ' + describeError(err)))
  interface AliveSocket extends WebSocket {
    isAlive?: boolean
  }

  wss.on('connection', (socket: WebSocket) => {
    const alive = socket as AliveSocket
    alive.isAlive = true
    alive.on('pong', () => {
      alive.isAlive = true
    })
    clients.add(socket)

    const send = (value: unknown): void => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (socket.bufferedAmount > WS_MAX_BUFFERED) {
        clients.delete(socket)
        socket.terminate()
        return
      }
      try {
        socket.send(JSON.stringify(value))
      } catch {
        clients.delete(socket)
      }
    }

    send({ type: 'hello', version, platform: 'web' })
    for (const status of getConnectionStatuses()) {
      send({ type: 'event', event: 'evt:conn-status', payload: status })
    }
    const prompts = getPendingPrompts()
    for (const prompt of prompts.hostKeys) {
      send({ type: 'event', event: 'evt:hostkey', payload: prompt })
    }
    for (const challenge of prompts.challenges) {
      send({ type: 'event', event: 'evt:auth-challenge', payload: challenge })
    }

    socket.on('message', (raw) => {
      let message: unknown
      try {
        message = JSON.parse(raw.toString())
      } catch {
        send({ type: 'rpc-result', id: null, ok: false, error: { message: 'Mensaje WebSocket no válido.' } })
        return
      }
      const request = message as Partial<RpcRequest>
      if (request.type !== 'rpc' || (typeof request.id !== 'number' && typeof request.id !== 'string')) {
        send({ type: 'rpc-result', id: null, ok: false, error: { message: 'Mensaje WebSocket no válido.' } })
        return
      }
      const id = request.id
      if (typeof request.method !== 'string' || request.method.length === 0 || request.method.length > 100) {
        send({ type: 'rpc-result', id, ok: false, error: { message: 'Método no válido.' } })
        return
      }
      const params = Array.isArray(request.params) ? request.params : []
      void invokeRpc(request.method, params)
        .then((result) => {
          send({ type: 'rpc-result', id, ok: true, result })
        })
        .catch((err: unknown) => {
          send({
            type: 'rpc-result',
            id,
            ok: false,
            error: {
              name: err instanceof Error ? err.name : 'Error',
              message: describeError(err)
            }
          })
        })
    })

    socket.on('close', () => {
      clients.delete(socket)
    })
    socket.on('error', () => {
      clients.delete(socket)
    })
  })

  const pingTimer = setInterval(() => {
    for (const socket of clients) {
      const alive = socket as AliveSocket
      if (alive.isAlive === false) {
        clients.delete(socket)
        socket.terminate()
        continue
      }
      alive.isAlive = false
      try {
        socket.ping()
      } catch {
        clients.delete(socket)
        socket.terminate()
      }
    }
  }, WS_PING_INTERVAL_MS)
  pingTimer.unref()

  server.on('upgrade', (req, socket, head) => {
    const url = requestUrl(req)
    if (url.pathname !== '/api/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!originMatchesHost(req) || !isAuthenticated(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening)
      rejectListen(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  }).catch(async (err: unknown) => {
    clearInterval(pingTimer)
    await disposeServices()
    throw err
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  const urls = listUrls(host, actualPort, Boolean(options.tls))
  const accessUrls = urls.map((base) => accessUrl(base, token))

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(pingTimer)
    for (const socket of clients) socket.terminate()
    clients.clear()
    wss.close()
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
      server.closeAllConnections()
    })
    await disposeServices()
  }

  return {
    server,
    host,
    port: actualPort,
    version,
    token,
    urls,
    accessUrls,
    close
  }
}
