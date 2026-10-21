import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretCodec } from '../main/store'

const TOKEN_FILE = 'server-token'
const MASTER_KEY_FILE = 'secret.key'
const TOKEN_BYTES = 32
const KEY_BYTES = 32
const IV_BYTES = 12

export function ensureDataDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return dataDir
}

function readTrimmed(file: string): string | null {
  try {
    const value = readFileSync(file, 'utf8').trim()
    try {
      chmodSync(file, 0o600)
    } catch {
      /* sistemas de archivos sin permisos POSIX */
    }
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Token de acceso persistente. Se genera una sola vez y se guarda con 0600 para
 * que las sesiones del navegador sobrevivan a reinicios del servicio.
 */
export function loadOrCreateToken(dataDir: string, minimumLength = 16): string {
  ensureDataDir(dataDir)
  const file = join(dataDir, TOKEN_FILE)
  const existing = readTrimmed(file)
  if (existing) {
    if (existing.length < minimumLength) {
      throw new Error(`El token guardado en ${file} es demasiado corto. Bórralo para generar uno nuevo.`)
    }
    return existing
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  try {
    writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return token
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const raced = readTrimmed(file)
    if (!raced) throw new Error(`No se pudo leer el token recién creado en ${file}.`)
    return raced
  }
}

export function tokenFilePath(dataDir: string): string {
  return join(dataDir, TOKEN_FILE)
}

function decodeKey(raw: string): Buffer | null {
  const value = raw.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex')
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === KEY_BYTES ? decoded : null
}

/**
 * Llave maestra del modo servidor. Prioridad: SSH_SFTP_MASTER_KEY y, si no,
 * `<data-dir>/secret.key` (creada con 0600 en el primer arranque).
 */
export function loadMasterKey(dataDir: string): Buffer {
  const fromEnv = process.env.SSH_SFTP_MASTER_KEY
  if (fromEnv) {
    const key = decodeKey(fromEnv)
    if (!key) throw new Error('SSH_SFTP_MASTER_KEY debe ser de 32 bytes en base64 o hex.')
    return key
  }

  ensureDataDir(dataDir)
  const file = join(dataDir, MASTER_KEY_FILE)
  const existing = readTrimmed(file)
  if (existing) {
    const key = decodeKey(existing)
    if (!key) throw new Error(`La llave ${file} está corrupta. Restáurala o borra los secretos guardados.`)
    return key
  }

  const key = randomBytes(KEY_BYTES)
  try {
    writeFileSync(file, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return key
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const raced = readTrimmed(file)
    const decoded = raced ? decodeKey(raced) : null
    if (!decoded) throw new Error(`No se pudo inicializar la llave en ${file}.`)
    return decoded
  }
}

function encryptWithKey(key: Buffer, plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url')
  ].join(':')
}

function decryptWithKey(key: Buffer, stored: string): string | null {
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  try {
    const iv = Buffer.from(parts[1], 'base64url')
    const tag = Buffer.from(parts[2], 'base64url')
    const ciphertext = Buffer.from(parts[3], 'base64url')
    if (iv.length !== IV_BYTES || tag.length !== 16) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * AES-256-GCM con una llave local. A diferencia de safeStorage, protege los
 * secretos si se copian los archivos, pero no frente a un atacante con acceso
 * total a la cuenta del servicio.
 */
export function createServerSecretCodec(dataDir: string): SecretCodec {
  const key = loadMasterKey(dataDir)
  return {
    isAvailable: () => true,
    encrypt: (plain: string) => encryptWithKey(key, plain),
    decrypt: (stored: string) => decryptWithKey(key, stored)
  }
}
