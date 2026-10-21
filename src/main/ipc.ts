import { BrowserWindow, dialog, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { ServerInput, ServerProfile } from '../shared/types'
import {
  appendAudit,
  deleteServer,
  getServer,
  initStore,
  listAudit,
  listServers,
  saveServer,
  trustHostKey
} from './store'
import {
  closeShell,
  connect,
  disconnect,
  disconnectAll,
  getSftp,
  openShell,
  replyAuthChallenge,
  resizeShell,
  setManagerEvents,
  writeShell
} from './ssh/manager'
import { assertInsideRoot, atomicUpload, LIMITS, listRemoteDirectories, remoteReadFile, remoteStat } from './ssh/sftp'
import { compareDirectories, hashBuffer, MISSING_REMOTE_HASH, readPair } from './ssh/compare'
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

/** Comparaciones en curso que el usuario pidió cancelar. */
const cancelledCompares = new Set<string>()

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
    secret: raw.secret === undefined ? undefined : asOptionalString(raw.secret, 'secret', 8192),
    clearSecret: raw.clearSecret === undefined ? undefined : asBoolean(raw.clearSecret, 'clearSecret')
  }
}

function requireProfile(serverId: unknown): ServerProfile {
  const id = asString(serverId, 'serverId', { max: 64 })
  const profile = getServer(id)
  if (!profile) throw new ValidationError('Servidor desconocido.')
  return profile
}

function assertRemoteAllowed(profile: ServerProfile, remotePath: string): void {
  if (profile.remoteRoot && profile.remoteRoot.startsWith('/')) {
    assertInsideRoot(profile.remoteRoot, remotePath)
  }
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  setManagerEvents({
    status: (status) => getWindow()?.webContents.send('evt:conn-status', status),
    hostkey: (prompt) => getWindow()?.webContents.send('evt:hostkey', prompt),
    'auth-challenge': (challenge) => getWindow()?.webContents.send('evt:auth-challenge', challenge),
    'terminal-data': (terminalId, data) =>
      getWindow()?.webContents.send('evt:term-data', { terminalId, data }),
    'terminal-exit': (terminalId, code) =>
      getWindow()?.webContents.send('evt:term-exit', { terminalId, code })
  })

  ipcMain.handle('servers:list', () => listServers())

  ipcMain.handle('servers:save', async (_e, input: unknown) => {
    const parsed = parseServerInput(input)
    const profile = await saveServer(parsed)
    return profile
  })

  ipcMain.handle('servers:delete', async (_e, serverId: unknown) => {
    const profile = requireProfile(serverId)
    await disconnect(profile.id)
    await deleteServer(profile.id)
    return true
  })

  ipcMain.handle('audit:list', () => listAudit())

  ipcMain.handle('conn:connect', async (_e, serverId: unknown) => {
    const profile = requireProfile(serverId)
    await connect(profile.id)
    return true
  })

  ipcMain.handle('conn:disconnect', async (_e, serverId: unknown) => {
    const profile = requireProfile(serverId)
    await disconnect(profile.id)
    return true
  })

  ipcMain.handle('auth:respond', (_e, challengeId: unknown, answer: unknown) => {
    replyAuthChallenge(asString(challengeId, 'challengeId', { max: 64 }), asString(answer, 'answer', { max: 256, allowEmpty: true }))
    return true
  })

  ipcMain.handle('hostkey:trust', async (_e, serverId: unknown, fingerprint: unknown, algorithm: unknown, host: unknown, port: unknown) => {
    const profile = requireProfile(serverId)
    const hostName = asString(host, 'host', { max: 255 })
    const portNumber = asNumber(port, 'port', { min: 1, max: 65535, integer: true })
    await trustHostKey(hostName, portNumber, asString(fingerprint, 'fingerprint', { max: 200 }), asString(algorithm, 'algorithm', { max: 64 }))
    await appendAudit({
      at: new Date().toISOString(),
      serverId: profile.id,
      serverName: profile.name,
      action: 'hostkey-trusted',
      detail: `${hostName}:${portNumber} ${String(fingerprint)}`
    })
    await connect(profile.id)
    return true
  })

  ipcMain.handle('term:open', (_e, serverId: unknown, cols: unknown, rows: unknown) => {
    const profile = requireProfile(serverId)
    const result = openShell(
      profile.id,
      asNumber(cols, 'cols', { min: 2, max: 500, integer: true }),
      asNumber(rows, 'rows', { min: 2, max: 300, integer: true })
    )
    return { terminalId: result.terminalId, serverId: profile.id }
  })

  ipcMain.handle('term:write', (_e, terminalId: unknown, data: unknown) => {
    writeShell(asString(terminalId, 'terminalId', { max: 64 }), asString(data, 'data', { max: 65536, allowEmpty: true }))
    return true
  })

  ipcMain.handle('term:resize', (_e, terminalId: unknown, cols: unknown, rows: unknown) => {
    resizeShell(
      asString(terminalId, 'terminalId', { max: 64 }),
      asNumber(cols, 'cols', { min: 2, max: 500, integer: true }),
      asNumber(rows, 'rows', { min: 2, max: 300, integer: true })
    )
    return true
  })

  ipcMain.handle('term:close', (_e, terminalId: unknown) => {
    closeShell(asString(terminalId, 'terminalId', { max: 64 }))
    return true
  })

  ipcMain.handle('local:pick-dir', async () => {
    const window = getWindow()
    const options = {
      title: 'Selecciona el directorio local',
      properties: ['openDirectory', 'createDirectory'] as const
    }
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('local:pick-file', async () => {
    const window = getWindow()
    const options = {
      title: 'Selecciona la llave privada',
      properties: ['openFile', 'showHiddenFiles'] as const
    }
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('remote:list-dirs', async (_e, serverId: unknown, path: unknown) => {
    const profile = requireProfile(serverId)
    const sftp = await getSftp(profile.id)
    const target = asAbsoluteRemotePath(path, 'path')
    assertRemoteAllowed(profile, target)
    return listRemoteDirectories(sftp, target)
  })

  ipcMain.handle(
    'compare:run',
    async (_e, requestId: unknown, serverId: unknown, remoteRoot: unknown, localRoot: unknown) => {
      const request = asString(requestId, 'requestId', { max: 64 })
      const profile = requireProfile(serverId)
      const remote = asAbsoluteRemotePath(remoteRoot, 'remoteRoot')
      const local = asString(localRoot, 'localRoot', { max: 2048 })
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
        getWindow()?.webContents.send('evt:compare-progress', {
          requestId: request,
          phase,
          dirs: counters.dirs,
          entries: counters.entries
        })
      }

      try {
        return await compareDirectories(sftp, remote, local, {
          shouldCancel: () => cancelledCompares.has(request),
          onProgress: report
        })
      } finally {
        cancelledCompares.delete(request)
      }
    }
  )

  ipcMain.handle('compare:cancel', (_e, requestId: unknown) => {
    cancelledCompares.add(asString(requestId, 'requestId', { max: 64 }))
    return true
  })

  ipcMain.handle(
    'file:read-pair',
    async (_e, serverId: unknown, remoteRoot: unknown, localRoot: unknown, relPath: unknown) => {
      const profile = requireProfile(serverId)
      const remoteRootPath = asAbsoluteRemotePath(remoteRoot, 'remoteRoot')
      const localRootPath = asString(localRoot, 'localRoot', { max: 2048 })
      const rel = asString(relPath, 'relPath', { max: 1024 })
      if (rel.split('/').some((part) => part.length === 0 || part === '..' || part === '.')) {
        throw new ValidationError('relPath no permitido.')
      }
      const remotePath = posix.join(remoteRootPath, rel)
      assertRemoteAllowed(profile, remotePath)
      const localPath = join(localRootPath, ...rel.split('/'))
      const sftp = await getSftp(profile.id)
      return readPair(sftp, remotePath, localPath, rel)
    }
  )

  ipcMain.handle('file:upload', async (_e, request: unknown) => {
    const raw = asObject(request, 'request')
    const profile = requireProfile(raw.serverId)
    const remotePath = asAbsoluteRemotePath(raw.remotePath, 'remotePath')
    assertRemoteAllowed(profile, remotePath)

    const content = asString(raw.content, 'content', { max: MAX_UPLOAD_BYTES, allowEmpty: true })
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

    const { backupPath } = await atomicUpload(sftp, remotePath, payload, backup)
    await appendAudit({
      at: new Date().toISOString(),
      serverId: profile.id,
      serverName: profile.name,
      action: 'upload',
      detail: `${posix.basename(remotePath)} (${payload.length} bytes)${backupPath ? ` backup=${backupPath}` : ''}`
    })

    return { ok: true, bytes: payload.length, remotePath, backupPath }
  })
}

export async function bootstrapStore(): Promise<void> {
  await initStore()
}

export function shutdown(): void {
  void disconnectAll()
}

export { LIMITS }
