import { mkdirSync } from 'node:fs'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuditEvent, ServerInput, ServerProfile } from '../shared/types'

interface ProfilesFile {
  version: 1
  servers: ServerProfile[]
}

interface SecretFile {
  version: 1
  /** serverId -> opaque string produced by the host's SecretCodec. */
  secrets: Record<string, string>
}

export interface KnownHost {
  fingerprint: string
  algorithm: string
  addedAt: string
}

interface KnownHostsFile {
  version: 1
  hosts: Record<string, KnownHost>
}

interface SettingsFile {
  version: 1
  /** Carpetas excluidas en la comparación; null = usar las predeterminadas. */
  excludedDirs: string[] | null
}

/**
 * Cifrado de secretos en reposo. El escritorio usa safeStorage (DPAPI, Keychain,
 * libsecret) y el servidor headless usa AES-256-GCM con una llave local.
 */
export interface SecretCodec {
  isAvailable(): boolean
  encrypt(plain: string): string
  /** Devuelve null si el valor no se puede descifrar (formato ajeno o llave perdida). */
  decrypt(stored: string): string | null
}

export interface StoreOptions {
  dataDir: string
  secrets: SecretCodec
}

const AUDIT_LIMIT = 2000

let options: StoreOptions | null = null

function dataDir(): string {
  if (!options) throw new Error('El almacén no se inicializó.')
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
  return options.dataDir
}

function pathFor(name: string): string {
  return join(dataDir(), name)
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}

/**
 * Serializa las escrituras del almacén. Varios clientes web pueden guardar a la
 * vez y antes compartían el mismo archivo temporal.
 */
let writeQueue: Promise<void> = Promise.resolve()

function queuedWrite(file: string, value: unknown): Promise<void> {
  const run = (): Promise<void> => writeJsonAtomic(file, value)
  const next = writeQueue.then(run, run)
  writeQueue = next.catch(() => {})
  return next
}

/** Espera a que se vacíe la cola antes de cerrar el proceso. */
export async function flushStore(): Promise<void> {
  await writeQueue
}

let profiles: ProfilesFile = { version: 1, servers: [] }
let secrets: SecretFile = { version: 1, secrets: {} }
let knownHosts: KnownHostsFile = { version: 1, hosts: {} }
let settings: SettingsFile = { version: 1, excludedDirs: null }
let audit: AuditEvent[] = []

export async function initStore(config: StoreOptions): Promise<void> {
  options = config
  profiles = await readJson<ProfilesFile>(pathFor('profiles.json'), { version: 1, servers: [] })
  if (!Array.isArray(profiles.servers)) profiles = { version: 1, servers: [] }
  secrets = await readJson<SecretFile>(pathFor('secrets.json'), { version: 1, secrets: {} })
  if (typeof secrets.secrets !== 'object' || secrets.secrets === null) {
    secrets = { version: 1, secrets: {} }
  }
  knownHosts = await readJson<KnownHostsFile>(pathFor('known_hosts.json'), { version: 1, hosts: {} })
  if (typeof knownHosts.hosts !== 'object' || knownHosts.hosts === null) {
    knownHosts = { version: 1, hosts: {} }
  }
  audit = await readJson<AuditEvent[]>(pathFor('audit.json'), [])
  if (!Array.isArray(audit)) audit = []
  const storedSettings = await readJson<SettingsFile>(pathFor('settings.json'), {
    version: 1,
    excludedDirs: null
  })
  settings = {
    version: 1,
    excludedDirs: Array.isArray(storedSettings.excludedDirs) ? storedSettings.excludedDirs : null
  }
}

export function listServers(): ServerProfile[] {
  return profiles.servers.map((s) => ({ ...s }))
}

export function getServer(id: string): ServerProfile | null {
  return profiles.servers.find((s) => s.id === id) ?? null
}

export async function saveServer(input: ServerInput): Promise<ServerProfile> {
  if (!options) throw new Error('El almacén no se inicializó.')
  const now = new Date().toISOString()
  const existing = input.id ? getServer(input.id) : null
  const id = existing?.id ?? randomUUID()

  if (input.secret != null || input.clearSecret) {
    if (input.clearSecret) {
      delete secrets.secrets[id]
    } else if (input.secret) {
      if (!options.secrets.isAvailable()) {
        throw new Error('El almacenamiento cifrado de secretos no está disponible en este equipo; no se guardará el secreto.')
      }
      secrets.secrets[id] = options.secrets.encrypt(input.secret)
    }
    await queuedWrite(pathFor('secrets.json'), secrets)
  }

  const profile: ServerProfile = {
    id,
    name: input.name.trim(),
    host: input.host.trim(),
    port: input.port,
    username: input.username.trim(),
    authMethod: input.authMethod,
    privateKeyPath: input.privateKeyPath?.trim() || null,
    remoteRoot: input.remoteRoot?.trim() || null,
    localRoot: input.localRoot?.trim() || null,
    jumpHost: input.jumpHost ?? null,
    hasSecret: id in secrets.secrets,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }

  if (existing) {
    profiles.servers = profiles.servers.map((s) => (s.id === id ? profile : s))
  } else {
    profiles.servers.push(profile)
  }
  await queuedWrite(pathFor('profiles.json'), profiles)
  return { ...profile }
}

export async function deleteServer(id: string): Promise<void> {
  profiles.servers = profiles.servers.filter((s) => s.id !== id)
  delete secrets.secrets[id]
  await queuedWrite(pathFor('profiles.json'), profiles)
  await queuedWrite(pathFor('secrets.json'), secrets)
}

/** Returns the decrypted secret, or null. Never log or forward this value to the renderer. */
export function getSecret(id: string): string | null {
  const stored = secrets.secrets[id]
  if (!stored || !options) return null
  return options.secrets.decrypt(stored)
}

function hostKeyId(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`
}

export function getKnownHost(host: string, port: number): KnownHost | null {
  return knownHosts.hosts[hostKeyId(host, port)] ?? null
}

export async function trustHostKey(
  host: string,
  port: number,
  fingerprint: string,
  algorithm: string
): Promise<void> {
  knownHosts.hosts[hostKeyId(host, port)] = {
    fingerprint,
    algorithm,
    addedAt: new Date().toISOString()
  }
  await queuedWrite(pathFor('known_hosts.json'), knownHosts)
}

export async function appendAudit(event: AuditEvent): Promise<void> {
  audit.push(event)
  if (audit.length > AUDIT_LIMIT) audit = audit.slice(audit.length - AUDIT_LIMIT)
  await queuedWrite(pathFor('audit.json'), audit)
}

export function listAudit(): AuditEvent[] {
  return audit.slice(-200).reverse()
}

export function getExcludedDirsSetting(): string[] | null {
  return settings.excludedDirs ? [...settings.excludedDirs] : null
}

export async function saveExcludedDirsSetting(dirs: string[]): Promise<void> {
  settings = { version: 1, excludedDirs: [...dirs] }
  await queuedWrite(pathFor('settings.json'), settings)
}
