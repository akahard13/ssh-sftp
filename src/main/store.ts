import { mkdirSync } from 'node:fs'
import { readFile, writeFile, rename, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AuditEvent,
  AuthMethod,
  ConfigImportResult,
  DeployFileRecord,
  DeployHistoryBundle,
  DeployImportResult,
  DeploySession,
  DeploySessionSummary,
  JumpHost,
  ServerConfigBundle,
  ServerConfigEntry,
  ServerInput,
  ServerProfile
} from '../shared/types'

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
/** deploy-sessions/<id>.json, cargados en memoria al arrancar. */
const deploySessions = new Map<string, DeploySession>()
/** serverId -> id de la sesión de despliegue abierta. */
const activeDeploySessions = new Map<string, string>()

const SESSIONS_DIR = 'deploy-sessions'
/** Tope de archivos registrados por sesión para no crecer sin límite. */
const MAX_SESSION_FILES = 50_000
const SESSION_STATUSES: readonly DeploySession['status'][] = ['active', 'closed']
const SERVER_AUTH_METHODS: readonly AuthMethod[] = ['password', 'key', 'agent']

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
  await loadDeploySessions()
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

/* ------------------------------------------------------------------ */
/* Sesiones de despliegue: un JSON por sesión en deploy-sessions/      */
/* ------------------------------------------------------------------ */

function sessionsDir(): string {
  return pathFor(SESSIONS_DIR)
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`)
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

function text(value: unknown, max = 2048): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function optionalText(value: unknown, max = 2048): string | null {
  const result = text(value, max).trim()
  return result.length > 0 ? result : null
}

function isoDate(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const time = Date.parse(value)
  return Number.isNaN(time) ? fallback : new Date(time).toISOString()
}

function port(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535 ? value : 22
}

function authMethod(value: unknown): AuthMethod {
  return SERVER_AUTH_METHODS.find((method) => method === value) ?? 'password'
}

function sanitizeRecord(value: unknown): DeployFileRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const relPath = text(raw.relPath)
  if (relPath.length === 0) return null
  const outcome =
    raw.outcome === 'uploaded' || raw.outcome === 'skipped' || raw.outcome === 'error'
      ? raw.outcome
      : null
  if (outcome === null) return null
  const bytes =
    typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes > 0
      ? Math.floor(raw.bytes)
      : 0
  const message = optionalText(raw.message, 500)
  return {
    relPath,
    remotePath: text(raw.remotePath, 4096),
    localPath: text(raw.localPath, 4096),
    bytes,
    outcome,
    ...(message ? { message } : {}),
    at: isoDate(raw.at, new Date().toISOString())
  }
}

function totalsFor(files: readonly DeployFileRecord[]): DeploySession['totals'] {
  const totals = { uploaded: 0, skipped: 0, errors: 0, bytes: 0 }
  for (const file of files) {
    if (file.outcome === 'uploaded') {
      totals.uploaded += 1
      totals.bytes += file.bytes
    } else if (file.outcome === 'skipped') {
      totals.skipped += 1
    } else {
      totals.errors += 1
    }
  }
  return totals
}

function sanitizeSession(value: unknown): DeploySession | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const serverId = text(raw.serverId, 128)
  if (serverId.length === 0) return null
  const files = Array.isArray(raw.files)
    ? raw.files
        .slice(0, MAX_SESSION_FILES)
        .map(sanitizeRecord)
        .filter((record): record is DeployFileRecord => record !== null)
    : []
  return {
    version: 1,
    id: isValidId(raw.id) ? raw.id : randomUUID(),
    serverId,
    serverName: optionalText(raw.serverName, 200) ?? serverId,
    host: text(raw.host, 300),
    username: text(raw.username, 200),
    remoteRoot: text(raw.remoteRoot),
    localRoot: text(raw.localRoot),
    startedAt: isoDate(raw.startedAt, new Date().toISOString()),
    endedAt: raw.endedAt === null || raw.endedAt === undefined ? null : isoDate(raw.endedAt, new Date().toISOString()),
    status: SESSION_STATUSES.find((status) => status === raw.status) ?? 'closed',
    files,
    totals: totalsFor(files)
  }
}

function cloneSession(session: DeploySession): DeploySession {
  return {
    ...session,
    files: session.files.map((file) => ({ ...file })),
    totals: { ...session.totals }
  }
}

function toSummary(session: DeploySession): DeploySessionSummary {
  return {
    version: session.version,
    id: session.id,
    serverId: session.serverId,
    serverName: session.serverName,
    host: session.host,
    username: session.username,
    remoteRoot: session.remoteRoot,
    localRoot: session.localRoot,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    status: session.status,
    totals: { ...session.totals }
  }
}

async function writeSessionFile(session: DeploySession): Promise<void> {
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 })
  await queuedWrite(sessionPath(session.id), session)
}

async function loadDeploySessions(): Promise<void> {
  deploySessions.clear()
  activeDeploySessions.clear()
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 })
  const names = await readdir(sessionsDir()).catch(() => [] as string[])
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const stored = await readJson<unknown>(join(sessionsDir(), name), null)
    const session = sanitizeSession(stored)
    if (!session) continue
    // El nombre del archivo manda: evita duplicados si el JSON trae otro id.
    if (`${session.id}.json` !== name) continue
    deploySessions.set(session.id, session)
  }
  // Una sesión «activa» viene de un proceso anterior que ya no sube nada; se
  // cierra para no bloquear las subidas nuevas tras un reinicio.
  for (const session of deploySessions.values()) {
    if (session.status !== 'active') continue
    session.status = 'closed'
    session.endedAt = session.endedAt ?? new Date().toISOString()
    await writeSessionFile(session)
  }
}

export function listDeploySessions(): DeploySessionSummary[] {
  return [...deploySessions.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(toSummary)
}

export function getDeploySession(id: string): DeploySession | null {
  const session = deploySessions.get(id)
  return session ? cloneSession(session) : null
}

export function getActiveDeploySession(serverId: string): DeploySessionSummary | null {
  const id = activeDeploySessions.get(serverId)
  if (!id) return null
  const session = deploySessions.get(id)
  if (!session || session.status !== 'active') {
    activeDeploySessions.delete(serverId)
    return null
  }
  return toSummary(session)
}

export async function startDeploySession(
  profile: ServerProfile,
  remoteRoot: string,
  localRoot: string
): Promise<DeploySessionSummary> {
  if (activeDeploySessions.has(profile.id)) {
    throw new Error('Ya hay una sesión de despliegue activa para este servidor. Finalízala primero.')
  }
  const session: DeploySession = {
    version: 1,
    id: randomUUID(),
    serverId: profile.id,
    serverName: profile.name,
    host: profile.host,
    username: profile.username,
    remoteRoot,
    localRoot,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'active',
    files: [],
    totals: { uploaded: 0, skipped: 0, errors: 0, bytes: 0 }
  }
  deploySessions.set(session.id, session)
  activeDeploySessions.set(profile.id, session.id)
  await writeSessionFile(session)
  return toSummary(session)
}

export async function endDeploySession(id: string): Promise<DeploySessionSummary> {
  const session = deploySessions.get(id)
  if (!session) throw new Error('La sesión de despliegue no existe.')
  if (session.status === 'active') {
    session.status = 'closed'
    session.endedAt = new Date().toISOString()
    if (activeDeploySessions.get(session.serverId) === session.id) {
      activeDeploySessions.delete(session.serverId)
    }
    await writeSessionFile(session)
  }
  return toSummary(session)
}

export async function deleteDeploySession(id: string): Promise<boolean> {
  const session = deploySessions.get(id)
  if (!session) return false
  deploySessions.delete(id)
  if (activeDeploySessions.get(session.serverId) === id) {
    activeDeploySessions.delete(session.serverId)
  }
  await rm(sessionPath(id), { force: true })
  return true
}

export async function appendDeployRecords(
  id: string,
  records: readonly DeployFileRecord[]
): Promise<void> {
  const session = deploySessions.get(id)
  if (!session || records.length === 0) return
  const room = MAX_SESSION_FILES - session.files.length
  if (room <= 0) return
  const accepted = records.slice(0, room)
  session.files.push(...accepted)
  const totals = totalsFor(accepted)
  session.totals.uploaded += totals.uploaded
  session.totals.skipped += totals.skipped
  session.totals.errors += totals.errors
  session.totals.bytes += totals.bytes
  await writeSessionFile(session)
}

export function exportDeployHistory(): DeployHistoryBundle {
  return {
    kind: 'deploysync-history',
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: [...deploySessions.values()]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map(cloneSession)
  }
}

export async function importDeployHistory(
  bundle: unknown,
  replace: boolean
): Promise<DeployImportResult> {
  if (typeof bundle !== 'object' || bundle === null) {
    throw new Error('El archivo no tiene un historial válido.')
  }
  const raw = bundle as Record<string, unknown>
  if (!Array.isArray(raw.sessions)) throw new Error('El archivo no tiene un historial válido.')

  const incoming: DeploySession[] = []
  for (const value of raw.sessions) {
    const session = sanitizeSession(value)
    if (!session) continue
    if (session.status === 'active') {
      session.status = 'closed'
      session.endedAt = session.endedAt ?? new Date().toISOString()
    }
    incoming.push(session)
  }

  if (replace) {
    for (const id of [...deploySessions.keys()]) await deleteDeploySession(id)
  }

  let imported = 0
  let skipped = 0
  for (const session of incoming) {
    if (deploySessions.has(session.id)) {
      if (!replace) {
        skipped += 1
        continue
      }
      session.id = randomUUID()
    }
    deploySessions.set(session.id, session)
    await writeSessionFile(session)
    imported += 1
  }
  return { imported, skipped, total: incoming.length }
}

/* ------------------------------------------------------------------ */
/* Exportar / importar la configuración de los servidores              */
/* ------------------------------------------------------------------ */

function sanitizeJumpHost(value: unknown): JumpHost | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const host = text(raw.host, 300).trim()
  const username = text(raw.username, 200).trim()
  if (host.length === 0 || username.length === 0) return null
  return {
    host,
    port: port(raw.port),
    username,
    authMethod: authMethod(raw.authMethod),
    privateKeyPath: optionalText(raw.privateKeyPath)
  }
}

function sanitizeConfigEntry(value: unknown): ServerConfigEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const name = text(raw.name, 200).trim()
  const host = text(raw.host, 300).trim()
  const username = text(raw.username, 200).trim()
  if (name.length === 0 || host.length === 0 || username.length === 0) return null
  return {
    id: isValidId(raw.id) ? raw.id : '',
    name,
    host,
    port: port(raw.port),
    username,
    authMethod: authMethod(raw.authMethod),
    privateKeyPath: optionalText(raw.privateKeyPath),
    remoteRoot: optionalText(raw.remoteRoot),
    localRoot: optionalText(raw.localRoot),
    jumpHost: sanitizeJumpHost(raw.jumpHost)
  }
}

export function exportServerConfig(): ServerConfigBundle {
  return {
    kind: 'deploysync-config',
    version: 1,
    exportedAt: new Date().toISOString(),
    servers: profiles.servers.map((server) => ({
      id: server.id,
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      authMethod: server.authMethod,
      privateKeyPath: server.privateKeyPath,
      remoteRoot: server.remoteRoot,
      localRoot: server.localRoot,
      jumpHost: server.jumpHost
    }))
  }
}

/**
 * Los secretos nunca viajan en el archivo: al importar un servidor nuevo hay
 * que volver a escribir la contraseña. Los servidores que ya existían
 * conservan su secreto guardado.
 */
export async function importServerConfig(
  bundle: unknown,
  replace: boolean
): Promise<ConfigImportResult> {
  if (typeof bundle !== 'object' || bundle === null) {
    throw new Error('El archivo no tiene una configuración válida.')
  }
  const raw = bundle as Record<string, unknown>
  if (!Array.isArray(raw.servers)) {
    throw new Error('El archivo no tiene una configuración válida.')
  }

  const incoming = raw.servers
    .map(sanitizeConfigEntry)
    .filter((entry): entry is ServerConfigEntry => entry !== null)
  const now = new Date().toISOString()
  const touched = new Set<string>()
  let created = 0
  let updated = 0

  for (const entry of incoming) {
    const existing =
      (entry.id ? profiles.servers.find((server) => server.id === entry.id) : undefined) ??
      profiles.servers.find(
        (server) =>
          server.host.toLowerCase() === entry.host.toLowerCase() &&
          server.port === entry.port &&
          server.username === entry.username
      ) ??
      null

    if (existing) {
      const profile: ServerProfile = {
        ...existing,
        name: entry.name,
        host: entry.host,
        port: entry.port,
        username: entry.username,
        authMethod: entry.authMethod,
        privateKeyPath: entry.privateKeyPath,
        remoteRoot: entry.remoteRoot,
        localRoot: entry.localRoot,
        jumpHost: entry.jumpHost,
        hasSecret: existing.id in secrets.secrets,
        updatedAt: now
      }
      profiles.servers = profiles.servers.map((server) =>
        server.id === existing.id ? profile : server
      )
      touched.add(existing.id)
      updated += 1
      continue
    }

    const id = entry.id && !profiles.servers.some((server) => server.id === entry.id) ? entry.id : randomUUID()
    profiles.servers.push({
      id,
      name: entry.name,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      authMethod: entry.authMethod,
      privateKeyPath: entry.privateKeyPath,
      remoteRoot: entry.remoteRoot,
      localRoot: entry.localRoot,
      jumpHost: entry.jumpHost,
      hasSecret: false,
      createdAt: now,
      updatedAt: now
    })
    touched.add(id)
    created += 1
  }

  if (replace) {
    const removed = profiles.servers.filter((server) => !touched.has(server.id))
    if (removed.length > 0) {
      for (const server of removed) delete secrets.secrets[server.id]
      profiles.servers = profiles.servers.filter((server) => touched.has(server.id))
      await queuedWrite(pathFor('secrets.json'), secrets)
    }
  }

  await queuedWrite(pathFor('profiles.json'), profiles)
  return { created, updated, total: incoming.length }
}
