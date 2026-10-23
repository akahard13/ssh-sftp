import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const SESSION_COOKIE = 'deploysync_session'
const SESSION_LABEL = 'deploysync-session-v1'
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export function sessionValue(token: string): string {
  return createHmac('sha256', token).update(SESSION_LABEL).digest('base64url')
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Comparación en tiempo constante (se comparan digests de longitud fija). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    const raw = part.slice(index + 1).trim()
    try {
      out[name] = decodeURIComponent(raw)
    } catch {
      out[name] = raw
    }
  }
  return out
}

export function readSessionCookie(req: IncomingMessage): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/**
 * Acepta la cookie de sesión o un Bearer token (útil para automatizar con curl).
 * El token nunca se guarda tal cual en la cookie: se guarda su HMAC.
 */
export function isAuthenticated(req: IncomingMessage, token: string): boolean {
  const cookie = readSessionCookie(req)
  if (cookie && safeEqual(cookie, sessionValue(token))) return true
  const bearer = bearerToken(req)
  return bearer !== null && safeEqual(bearer, token)
}

export function sessionCookie(value: string, secure: boolean): string {
  const flags = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_MAX_AGE_SECONDS}`]
  if (secure) flags.push('Secure')
  return flags.join('; ')
}

export function clearSessionCookie(secure: boolean): string {
  const flags = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (secure) flags.push('Secure')
  return flags.join('; ')
}

/** Evita que un sitio externo use la sesión del navegador (CSRF y WS). */
export function originMatchesHost(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host.toLowerCase() === new URL('http://' + host).host.toLowerCase()
  } catch {
    return false
  }
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 5 * 60 * 1000
  ) {}

  private current(key: string): { count: number; resetAt: number } | null {
    const entry = this.attempts.get(key)
    if (!entry) return null
    if (Date.now() >= entry.resetAt) {
      this.attempts.delete(key)
      return null
    }
    return entry
  }

  allowed(key: string): boolean {
    const entry = this.current(key)
    return !entry || entry.count < this.maxFailures
  }

  retryAfterSeconds(key: string): number {
    const entry = this.current(key)
    if (!entry) return 0
    return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000))
  }

  fail(key: string): void {
    if (this.attempts.size > 10_000) {
      for (const [candidate, entry] of this.attempts) {
        if (Date.now() >= entry.resetAt) this.attempts.delete(candidate)
      }
    }
    const entry = this.current(key)
    if (!entry) {
      this.attempts.set(key, { count: 1, resetAt: Date.now() + this.windowMs })
      return
    }
    entry.count += 1
  }

  success(key: string): void {
    this.attempts.delete(key)
  }
}
