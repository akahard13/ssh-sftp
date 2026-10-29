import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type {
  CompareEntry,
  CompareProgress,
  ConnectionStatus,
  LocalDirListing,
  PathsError,
  PathsResult,
  ServerInput,
  ServerProfile,
  UploadManyResult,
  UploadProgress
} from '../shared/types'
import {
  appendAudit,
  deleteServer,
  getExcludedDirsSetting,
  flushStore,
  getServer,
  initStore,
  listAudit,
  listServers,
  saveExcludedDirsSetting,
  saveServer,
  trustHostKey,
  type SecretCodec
} from './store'
import {
  closeShell,
  connect,
  disconnect,
  disconnectAll,
  getSftp,
  listPendingPrompts,
  listStatuses,
  openShell,
  replyAuthChallenge,
  resizeShell,
  setManagerEvents,
  writeShell
} from './ssh/manager'
import {
  alongsideBackupPath,
  assertInsideRoot,
  atomicUpload,
  DEFAULT_EXCLUDES,
  listRemoteDirectories,
  remoteReadFile,
  remoteStat
} from './ssh/sftp'
import { compareDirectories, hashBuffer, MISSING_REMOTE_HASH, readPair } from './ssh/compare'
import { uploadTargets, type UploadTarget } from './ssh/upload'
import { writeLocalFile } from './localFiles'
import {
  asAbsoluteRemotePath,
  asBoolean,
  asEnum,
  asNumber,
  asObject,
  asOptionalString,
  asString,
  ValidationError
} from './validate'

const AUTH_METHODS = ['password', 'key', 'agent'] as const
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const MAX_LOCAL_ENTRIES = 2000
/** Archivos por tanda y subidas simultáneas al subir una carpeta completa. */
const MAX_UPLOAD_FILES = 500
const UPLOAD_CONCURRENCY = 4
/** Rutas que acepta una tanda pegada a mano. */
const MAX_PATH_LINES = 200
/** Consultas de estado remoto simultáneas al listar rutas. */
const PATH_STAT_CONCURRENCY = 8

/** Eventos que el núcleo emite hacia el host (Electron IPC o WebSocket). */
export type CoreEventChannel =
  | 'evt:conn-status'
  | 'evt:hostkey'
  | 'evt:auth-challenge'
  | 'evt:term-data'
  | 'evt:term-exit'
  | 'evt:compare-progress'
  | 'evt:upload-progress'

export type CoreEmitter = (channel: CoreEventChannel, payload: unknown) => void

export interface CoreServicesOptions {
  /** Carpeta donde viven profiles.json, secrets.json, known_hosts.json y la auditoría. */
  dataDir: string
  secrets: SecretCodec
  emitter: CoreEmitter
}

/** Comparaciones en curso que el usuario pidió cancelar. */
const cancelledCompares = new Set<string>()

let emit: CoreEmitter = () => {}

export async function initServices(options: CoreServicesOptions): Promise<void> {
  emit = options.emitter
  await initStore({ dataDir: options.dataDir, secrets: options.secrets })
  setManagerEvents({
    status: (status) => emit('evt:conn-status', status),
    hostkey: (prompt) => emit('evt:hostkey', prompt),
    'auth-challenge': (challenge) => emit('evt:auth-challenge', challenge),
    'terminal-data': (terminalId, data) => emit('evt:term-data', { terminalId, data }),
    'terminal-exit': (terminalId, code) => emit('evt:term-exit', { terminalId, code })
  })
}

export async function disposeServices(): Promise<void> {
  setManagerEvents(null)
  await disconnectAll()
  await flushStore()
}

export function getConnectionStatuses(): ConnectionStatus[] {
  return listStatuses()
}

export function getPendingPrompts(): ReturnType<typeof listPendingPrompts> {
  return listPendingPrompts()
}

function parseJumpHost(value: unknown): ServerInput['jumpHost'] {
  if (value === null || value === undefined) return null
  const raw = asObject(value, 'jumpHost')
  return {
    host: asString(raw.host, 'jumpHost.host', { max: 255 }),
    port: asNumber(raw.port, 'jumpHost.port', { min: 1, max: 65535, integer: true }),
    username: asString(raw.username, 'jumpHost.username', { max: 128 }),
    authMethod: asEnum(raw.authMethod, 'jumpHost.authMethod', AUTH_METHODS),
    privateKeyPath: asOptionalString(raw.privateKeyPath, 'jumpHost.privateKeyPath', 2048)
  }
}

function parseServerInput(value: unknown): ServerInput {
  const raw = asObject(value, 'server')
  return {
    id: raw.id === undefined || raw.id === null ? undefined : asString(raw.id, 'id', { max: 64 }),
    name: asString(raw.name, 'name', { max: 120 }),
    host: asString(raw.host, 'host', { max: 255 }),
    port: asNumber(raw.port, 'port', { min: 1, max: 65535, integer: true }),
    username: asString(raw.username, 'username', { max: 128 }),
    authMethod: asEnum(raw.authMethod, 'authMethod', AUTH_METHODS),
    privateKeyPath: asOptionalString(raw.privateKeyPath, 'privateKeyPath', 2048),
    remoteRoot: asOptionalString(raw.remoteRoot, 'remoteRoot', 1024),
    localRoot: asOptionalString(raw.localRoot, 'localRoot', 2048),
    jumpHost: parseJumpHost(raw.jumpHost),
    secret:
      raw.secret === undefined
        ? undefined
        : asOptionalString(raw.secret, 'secret', 8192, { trim: false }),
    clearSecret: raw.clearSecret === undefined ? undefined : asBoolean(raw.clearSecret, 'clearSecret')
  }
}

function requireProfile(serverId: unknown): ServerProfile {
  const id = asString(serverId, 'serverId', { max: 64 })
  const profile = getServer(id)
  if (!profile) throw new ValidationError('Servidor desconocido.')
  return profile
}

/** Ruta relativa con `/` y sin segmentos vacíos, `.` ni `..`. */
function parseRelPath(value: unknown): string {
  const rel = asString(value, 'relPath', { max: 1024 })
  if (rel.split('/').some((part) => part.length === 0 || part === '..' || part === '.')) {
    throw new ValidationError('relPath no permitido.')
  }
  return rel
}

/** Patrones de exclusión: nombres de carpeta o archivo, y `*`/`?` como comodines. */
function parseExcludePatterns(value: unknown, fallback: readonly string[] | null): string[] {
  if (value === undefined || value === null) {
    if (!fallback) throw new ValidationError('La lista de exclusiones es obligatoria.')
    return [...fallback]
  }
  if (!Array.isArray(value)) throw new ValidationError('Las exclusiones deben ser una lista.')
  if (value.length > 100) throw new ValidationError('Demasiados patrones de exclusión.')

  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const pattern = asString(raw, 'exclude', { max: 100, allowEmpty: true })
    if (pattern.length === 0) continue
    if (pattern.includes('\\') || pattern.includes('..') || pattern.startsWith('/')) {
      throw new ValidationError(`Patrón de exclusión no permitido: ${pattern}`)
    }
    if (seen.has(pattern)) continue
    seen.add(pattern)
    out.push(pattern)
  }
  return out
}

function assertRemoteAllowed(profile: ServerProfile, remotePath: string): void {
  if (profile.remoteRoot && profile.remoteRoot.startsWith('/')) {
    assertInsideRoot(profile.remoteRoot, remotePath)
  }
}

/**
 * Lista subdirectorios y archivos de una ruta del equipo que ejecuta el servicio.
 * En escritorio es el disco local; en modo servidor es el disco del host.
 */
async function listLocalDirectories(rawPath: unknown): Promise<LocalDirListing> {
  const home = homedir()
  let requested =
    rawPath === null || rawPath === undefined || rawPath === ''
      ? home
      : asString(rawPath, 'path', { max: 2048 })
  if (requested === '~' || requested.startsWith('~/') || requested.startsWith('~\\')) {
    requested = join(home, requested.slice(1))
  }
  let resolved = resolve(requested)
  let info = await stat(resolved).catch(() => null)
  if (info?.isFile()) {
    // Al abrir el explorador con una ruta de archivo (p. ej. una llave), se
    // muestra su carpeta para poder elegir el archivo desde ahí.
    resolved = dirname(resolved)
    info = await stat(resolved).catch(() => null)
  }
  if (!info?.isDirectory()) throw new ValidationError('El directorio no existe o no es una carpeta.')

  const dirents = await readdir(resolved, { withFileTypes: true })
  const entries: LocalDirListing['entries'] = []
  for (const dirent of dirents.slice(0, MAX_LOCAL_ENTRIES)) {
    const entryPath = join(resolved, dirent.name)
    let isDirectory = dirent.isDirectory()
    if (dirent.isSymbolicLink()) {
      const target = await stat(entryPath).catch(() => null)
      if (!target) continue
      isDirectory = target.isDirectory()
    } else if (!isDirectory && !dirent.isFile()) {
      continue
    }
    entries.push({ name: dirent.name, path: entryPath, isDirectory })
  }
  entries.sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
  )

  const parent = dirname(resolved)
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    entries
  }
}

/** Marca de tiempo usada para separar cada tanda de respaldos. */
function backupStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
}

/**
 * Convierte una ruta escrita a mano (relativa a la raíz local o absoluta) en
 * una ruta absoluta del equipo que ejecuta el servicio.
 */
function resolveLocalTarget(localRoot: string, raw: string): string {
  const cleaned = raw.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  const expanded =
    cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('~\\')
      ? join(homedir(), cleaned.slice(1))
      : cleaned
  return isAbsolute(expanded) ? resolve(expanded) : resolve(localRoot, expanded)
}

/** Ruta relativa con `/` si `abs` queda dentro de `root`; null si se sale. */
function relInsideLocalRoot(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || /^\.\.[\\/]/.test(rel)) {
    return null
  }
  return rel.split(/[\\/]+/).filter(Boolean).join('/')
}

interface LocalPathFile {
  relPath: string
  size: number
}

/** Acumula los archivos de una carpeta local, sin seguir enlaces a carpetas. */
async function walkLocalDir(
  abs: string,
  rel: string,
  out: LocalPathFile[],
  quota: number
): Promise<void> {
  const dirents = await readdir(abs, { withFileTypes: true }).catch(() => [])
  for (const dirent of dirents) {
    if (out.length >= quota) return
    const childAbs = join(abs, dirent.name)
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
    if (dirent.isDirectory()) {
      await walkLocalDir(childAbs, childRel, out, quota)
      continue
    }
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue
    const info = await stat(childAbs).catch(() => null)
    if (info?.isFile()) out.push({ relPath: childRel, size: info.size })
  }
}

/** Resuelve las rutas pegadas por el usuario en archivos concretos del proyecto. */
async function resolveLocalPaths(
  localRoot: string,
  rawPaths: readonly string[]
): Promise<{ files: LocalPathFile[]; errors: PathsError[]; truncated: boolean }> {
  const root = resolve(localRoot)
  const files: LocalPathFile[] = []
  const errors: PathsError[] = []
  const seen = new Set<string>()
  let truncated = false

  for (const value of rawPaths) {
    const rawPath = asString(value, 'path', { max: 2048 })
    if (!rawPath.trim()) continue
    if (files.length >= MAX_UPLOAD_FILES) {
      truncated = true
      break
    }
    const abs = resolveLocalTarget(root, rawPath)
    const rel = relInsideLocalRoot(root, abs)
    if (rel === null) {
      errors.push({ path: rawPath.trim(), message: 'Queda fuera del directorio local.' })
      continue
    }
    const info = await stat(abs).catch(() => null)
    if (!info) {
      errors.push({ path: rawPath.trim(), message: 'No existe en local.' })
      continue
    }
    const found: LocalPathFile[] = []
    if (info.isDirectory()) {
      await walkLocalDir(abs, rel, found, MAX_UPLOAD_FILES - files.length)
    } else if (info.isFile()) {
      found.push({ relPath: rel, size: info.size })
    } else {
      errors.push({ path: rawPath.trim(), message: 'No es un archivo ni una carpeta.' })
      continue
    }
    if (found.length >= MAX_UPLOAD_FILES - files.length) truncated = true
    for (const file of found) {
      if (files.length >= MAX_UPLOAD_FILES) {
        truncated = true
        break
      }
      if (seen.has(file.relPath)) continue
      seen.add(file.relPath)
      files.push(file)
    }
  }

  return { files, errors, truncated }
}

async function runCompare(requestId: string, args: unknown[]): Promise<unknown> {
  const request = asString(requestId, 'requestId', { max: 64 })
  const profile = requireProfile(args[0])
  const remote = asAbsoluteRemotePath(args[1], 'remoteRoot')
  const local = asString(args[2], 'localRoot', { max: 2048 })
  const excludePatterns = parseExcludePatterns(args[3], DEFAULT_EXCLUDES)
  assertRemoteAllowed(profile, remote)
  const localInfo = await stat(local).catch(() => null)
  if (!localInfo?.isDirectory()) throw new ValidationError('El directorio local no existe.')
  const sftp = await getSftp(profile.id)
  cancelledCompares.delete(request)

  const counters = { dirs: 0, entries: 0 }
  let lastEmit = 0
  const report = (
    phase: 'walking-remote' | 'walking-local',
    delta: { dirs: number; entries: number }
  ): void => {
    counters.dirs += delta.dirs
    counters.entries += delta.entries
    const now = Date.now()
    if (now - lastEmit < 200) return
    lastEmit = now
    const progress: CompareProgress = {
      requestId: request,
      phase,
      dirs: counters.dirs,
      entries: counters.entries
    }
    emit('evt:compare-progress', progress)
  }

  try {
    return await compareDirectories(sftp, remote, local, excludePatterns, {
      shouldCancel: () => cancelledCompares.has(request),
      onProgress: report
    })
  } finally {
    cancelledCompares.delete(request)
  }
}

/**
 * Punto único de entrada para las operaciones de la app. Lo usan tanto el
 * adaptador IPC de Electron como el servidor HTTP/WebSocket.
 */
export async function invokeCore(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'servers:list':
      return listServers()

    case 'servers:save':
      return saveServer(parseServerInput(args[0]))

    case 'servers:delete': {
      const profile = requireProfile(args[0])
      await disconnect(profile.id)
      await deleteServer(profile.id)
      return true
    }

    case 'audit:list':
      return listAudit()

    case 'conn:connect': {
      const profile = requireProfile(args[0])
      await connect(profile.id)
      return true
    }

    case 'conn:disconnect': {
      const profile = requireProfile(args[0])
      await disconnect(profile.id)
      return true
    }

    case 'auth:respond':
      replyAuthChallenge(
        asString(args[0], 'challengeId', { max: 64 }),
        asString(args[1], 'answer', { max: 256, allowEmpty: true })
      )
      return true

    case 'hostkey:trust': {
      const profile = requireProfile(args[0])
      const fingerprint = asString(args[1], 'fingerprint', { max: 200 })
      const algorithm = asString(args[2], 'algorithm', { max: 64 })
      const hostName = asString(args[3], 'host', { max: 255 })
      const portNumber = asNumber(args[4], 'port', { min: 1, max: 65535, integer: true })
      await trustHostKey(hostName, portNumber, fingerprint, algorithm)
      await appendAudit({
        at: new Date().toISOString(),
        serverId: profile.id,
        serverName: profile.name,
        action: 'hostkey-trusted',
        detail: `${hostName}:${portNumber} ${fingerprint}`
      })
      await connect(profile.id)
      return true
    }

    case 'term:open': {
      const profile = requireProfile(args[0])
      const result = openShell(
        profile.id,
        asNumber(args[1], 'cols', { min: 2, max: 500, integer: true }),
        asNumber(args[2], 'rows', { min: 2, max: 300, integer: true })
      )
      return { terminalId: result.terminalId, serverId: profile.id }
    }

    case 'term:write':
      writeShell(
        asString(args[0], 'terminalId', { max: 64 }),
        asString(args[1], 'data', { max: 65536, allowEmpty: true, trim: false })
      )
      return true

    case 'term:resize':
      resizeShell(
        asString(args[0], 'terminalId', { max: 64 }),
        asNumber(args[1], 'cols', { min: 2, max: 500, integer: true }),
        asNumber(args[2], 'rows', { min: 2, max: 300, integer: true })
      )
      return true

    case 'term:close':
      closeShell(asString(args[0], 'terminalId', { max: 64 }))
      return true

    case 'local:list-dirs':
      return listLocalDirectories(args[0])

    case 'remote:list-dirs': {
      const profile = requireProfile(args[0])
      const sftp = await getSftp(profile.id)
      const target = asAbsoluteRemotePath(args[1], 'path')
      assertRemoteAllowed(profile, target)
      return listRemoteDirectories(sftp, target)
    }

    case 'compare:defaults':
      return { defaults: [...DEFAULT_EXCLUDES], saved: getExcludedDirsSetting() }

    case 'compare:save-excludes':
      await saveExcludedDirsSetting(parseExcludePatterns(args[0], null))
      return true

    case 'compare:run':
      return runCompare(asString(args[0], 'requestId', { max: 64 }), args.slice(1))

    case 'compare:cancel':
      cancelledCompares.add(asString(args[0], 'requestId', { max: 64 }))
      return true

    case 'file:read-pair': {
      const profile = requireProfile(args[0])
      const remoteRootPath = asAbsoluteRemotePath(args[1], 'remoteRoot')
      const localRootPath = asString(args[2], 'localRoot', { max: 2048 })
      const rel = parseRelPath(args[3])
      const remotePath = posix.join(remoteRootPath, rel)
      assertRemoteAllowed(profile, remotePath)
      const localPath = join(localRootPath, ...rel.split('/'))
      const sftp = await getSftp(profile.id)
      return readPair(sftp, remotePath, localPath, rel)
    }

    case 'file:upload': {
      const raw = asObject(args[0], 'request')
      const profile = requireProfile(raw.serverId)
      const remotePath = asAbsoluteRemotePath(raw.remotePath, 'remotePath')
      assertRemoteAllowed(profile, remotePath)

      const content = asString(raw.content, 'content', {
        max: MAX_UPLOAD_BYTES,
        allowEmpty: true,
        trim: false
      })
      const expectedHash = asString(raw.expectedRemoteHash, 'expectedRemoteHash', { max: 128 })
      const backup = asBoolean(raw.backup, 'backup')

      const sftp = await getSftp(profile.id)

      if (expectedHash === MISSING_REMOTE_HASH) {
        const existing = await remoteStat(sftp, remotePath)
        if (existing) {
          throw new Error('El archivo ya existe en el servidor. Vuelve a cargarlo antes de subir.')
        }
      } else {
        const currentRemote = await remoteReadFile(sftp, remotePath)
        if (hashBuffer(currentRemote) !== expectedHash) {
          throw new Error('El archivo cambió en el servidor desde que lo comparaste. Vuelve a cargarlo.')
        }
      }

      const payload = Buffer.from(content, 'utf8')
      if (payload.length > MAX_UPLOAD_BYTES) throw new ValidationError('El contenido excede el tamaño permitido.')

      const { backupPath } = await atomicUpload(
        sftp,
        remotePath,
        payload,
        backup ? alongsideBackupPath(remotePath) : null
      )
      await appendAudit({
        at: new Date().toISOString(),
        serverId: profile.id,
        serverName: profile.name,
        action: 'upload',
        detail: `${posix.basename(remotePath)} (${payload.length} bytes)${backupPath ? ` backup=${backupPath}` : ''}`
      })

      return { ok: true, bytes: payload.length, remotePath, backupPath }
    }

    case 'file:upload-many': {
      const raw = asObject(args[0], 'request')
      const requestId = asString(raw.requestId, 'requestId', { max: 64 })
      const profile = requireProfile(raw.serverId)
      const remoteRootPath = asAbsoluteRemotePath(raw.remoteRoot, 'remoteRoot')
      const localRootPath = asString(raw.localRoot, 'localRoot', { max: 2048 })
      const backup = asBoolean(raw.backup, 'backup')
      const backupFolder =
        raw.backupFolder === undefined || raw.backupFolder === null
          ? null
          : asString(raw.backupFolder, 'backupFolder', { max: 120 })
      if (
        backupFolder !== null &&
        (backupFolder.trim().length === 0 ||
          backupFolder.includes('..') ||
          backupFolder.includes('\\') ||
          backupFolder.startsWith('/'))
      ) {
        throw new ValidationError('Carpeta de respaldo no permitida.')
      }
      if (!Array.isArray(raw.relPaths)) throw new ValidationError('relPaths debe ser una lista.')
      if (raw.relPaths.length > MAX_UPLOAD_FILES) {
        throw new ValidationError(`Sube como máximo ${MAX_UPLOAD_FILES} archivos por tanda.`)
      }

      const seen = new Set<string>()
      const targets: UploadTarget[] = []
      for (const value of raw.relPaths) {
        const relPath = parseRelPath(value)
        if (seen.has(relPath)) continue
        seen.add(relPath)
        const remotePath = posix.join(remoteRootPath, relPath)
        assertRemoteAllowed(profile, remotePath)
        targets.push({
          relPath,
          remotePath,
          localPath: join(localRootPath, ...relPath.split('/'))
        })
      }

      const sftp = await getSftp(profile.id)
      const backupDir =
        backupFolder !== null
          ? posix.join(remoteRootPath, backupFolder.trim(), backupStamp())
          : null
      let lastEmit = 0
      const summary = await uploadTargets(sftp, targets, {
        backup,
        backupDir,
        maxBytes: MAX_UPLOAD_BYTES,
        concurrency: UPLOAD_CONCURRENCY,
        onProgress: (done, total) => {
          const now = Date.now()
          if (now - lastEmit < 150 && done < total) return
          lastEmit = now
          const progress: UploadProgress = { requestId, done, total }
          emit('evt:upload-progress', progress)
        }
      })

      if (summary.uploaded > 0) {
        await appendAudit({
          at: new Date().toISOString(),
          serverId: profile.id,
          serverName: profile.name,
          action: 'upload',
          detail:
            `${summary.uploaded} archivo(s) desde ${localRootPath}` +
            (backupDir ? ` con respaldo en ${backupDir}` : backup ? ' con respaldo' : '')
        })
      }

      const result: UploadManyResult = { ok: true, ...summary }
      return result
    }

    case 'file:list-paths': {
      const raw = asObject(args[0], 'request')
      const profile = requireProfile(raw.serverId)
      const remoteRootPath = asAbsoluteRemotePath(raw.remoteRoot, 'remoteRoot')
      const localRootPath = asString(raw.localRoot, 'localRoot', { max: 2048 })
      assertRemoteAllowed(profile, remoteRootPath)
      if (!Array.isArray(raw.paths)) throw new ValidationError('paths debe ser una lista.')
      if (raw.paths.length > MAX_PATH_LINES) {
        throw new ValidationError(`Pega como máximo ${MAX_PATH_LINES} rutas por tanda.`)
      }
      const rootInfo = await stat(localRootPath).catch(() => null)
      if (!rootInfo?.isDirectory()) throw new ValidationError('El directorio local no existe.')

      const { files, errors, truncated } = await resolveLocalPaths(localRootPath, raw.paths)
      const sftp = await getSftp(profile.id)
      const entries: CompareEntry[] = new Array(files.length)
      let cursor = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = cursor
          cursor += 1
          const file = files[index]
          if (!file) return
          const remote = await remoteStat(sftp, posix.join(remoteRootPath, file.relPath)).catch(
            () => null
          )
          entries[index] = {
            relPath: file.relPath,
            status: !remote ? 'local-only' : remote.size === file.size ? 'same-size' : 'modified',
            isDirectory: false,
            localSize: file.size,
            remoteSize: remote ? remote.size : null
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(PATH_STAT_CONCURRENCY, files.length) }, () => worker())
      )

      const result: PathsResult = {
        entries: [...entries].sort((a, b) => a.relPath.localeCompare(b.relPath)),
        errors,
        truncated
      }
      return result
    }

    case 'file:download': {
      const raw = asObject(args[0], 'request')
      const profile = requireProfile(raw.serverId)
      const rel = parseRelPath(raw.relPath)
      const remoteRootPath = asAbsoluteRemotePath(raw.remoteRoot, 'remoteRoot')
      const remotePath = posix.join(remoteRootPath, rel)
      assertRemoteAllowed(profile, remotePath)

      const localRootPath = asString(raw.localRoot, 'localRoot', { max: 2048 })

      const sftp = await getSftp(profile.id)
      const remoteInfo = await remoteStat(sftp, remotePath)
      if (!remoteInfo) throw new Error('El archivo ya no existe en el servidor.')
      if (remoteInfo.size > MAX_DOWNLOAD_BYTES) {
        throw new ValidationError('El archivo excede el tamaño permitido para descargar (64 MB).')
      }

      const payload = await remoteReadFile(sftp, remotePath)
      const localPath = await writeLocalFile(localRootPath, rel, payload)

      await appendAudit({
        at: new Date().toISOString(),
        serverId: profile.id,
        serverName: profile.name,
        action: 'download',
        detail: `${posix.basename(remotePath)} (${payload.length} bytes)`
      })

      return { ok: true, bytes: payload.length, localPath }
    }

    default:
      throw new ValidationError(`Método desconocido: ${method}`)
  }
}
