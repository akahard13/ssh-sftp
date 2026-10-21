import { statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, posix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { CompareEntry, CompareResult, CompareStatus, FilePair } from '../../shared/types'
import {
  DEFAULT_EXCLUDED_DIRS,
  LIMITS,
  remoteReadFile,
  remoteStat,
  walkRemote,
  walkTree,
  type WalkedItem
} from './sftp'

/** Diferencia tolerada entre la fecha remota (segundos) y la local, en milisegundos. */
const MTIME_TOLERANCE_MS = 2000

export interface CompareWalkHooks {
  shouldCancel: () => boolean
  onProgress: (
    phase: 'walking-remote' | 'walking-local',
    delta: { dirs: number; entries: number }
  ) => void
}

async function listLocalDir(abs: string): Promise<WalkedItem[]> {
  const dirents = await readdir(abs, { withFileTypes: true })
  const items: WalkedItem[] = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      items.push({ name: dirent.name, isDirectory: true, size: 0, mtime: 0 })
      continue
    }
    if (!dirent.isFile()) continue
    try {
      const info = statSync(join(abs, dirent.name))
      items.push({ name: dirent.name, isDirectory: false, size: info.size, mtime: info.mtimeMs })
    } catch {
      /* archivo ilegible, se omite */
    }
  }
  return items
}

export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function localPathOf(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'))
}

function classify(
  remoteSize: number,
  remoteMtime: number,
  localSize: number,
  localMtime: number
): CompareStatus {
  if (remoteSize !== localSize) return 'modified'
  if (remoteMtime > 0 && localMtime > 0 && Math.abs(remoteMtime - localMtime) <= MTIME_TOLERANCE_MS) {
    return 'identical'
  }
  return 'same-size'
}

/**
 * Compara los dos árboles usando solo tamaño y fecha: no descarga ningún archivo.
 * El contenido se compara únicamente al abrir un archivo (ver `readPair`).
 * Devuelve null si el usuario cancela.
 */
export async function compareDirectories(
  sftp: SFTPWrapper,
  remoteRoot: string,
  localRoot: string,
  hooks: CompareWalkHooks
): Promise<CompareResult | null> {
  const excluded = DEFAULT_EXCLUDED_DIRS

  const remote = await walkRemote(remoteRoot, sftp, {
    join: posix.join,
    excluded,
    shouldCancel: hooks.shouldCancel,
    onProgress: (delta) =>
      hooks.onProgress('walking-remote', { dirs: delta.dirs ?? 0, entries: delta.entries ?? 0 })
  })
  if (hooks.shouldCancel()) return null

  const local = await walkTree(localRoot, listLocalDir, {
    join,
    excluded,
    shouldCancel: hooks.shouldCancel,
    onProgress: (delta) =>
      hooks.onProgress('walking-local', { dirs: delta.dirs ?? 0, entries: delta.entries ?? 0 })
  })
  if (hooks.shouldCancel()) return null

  const remoteMap = new Map(remote.entries.map((e) => [e.relPath, e]))
  const localMap = new Map(local.entries.map((e) => [e.relPath, e]))
  const allPaths = new Set<string>([...remoteMap.keys(), ...localMap.keys()])

  const entries: CompareEntry[] = []
  for (const relPath of [...allPaths].sort((a, b) => a.localeCompare(b))) {
    const remoteEntry = remoteMap.get(relPath) ?? null
    const localEntry = localMap.get(relPath) ?? null

    if (!remoteEntry) {
      entries.push({
        relPath,
        status: 'local-only',
        isDirectory: false,
        localSize: localEntry?.size ?? null,
        remoteSize: null
      })
      continue
    }
    if (!localEntry) {
      entries.push({
        relPath,
        status: 'remote-only',
        isDirectory: false,
        localSize: null,
        remoteSize: remoteEntry.size
      })
      continue
    }

    entries.push({
      relPath,
      status: classify(remoteEntry.size, remoteEntry.mtime, localEntry.size, localEntry.mtime),
      isDirectory: false,
      localSize: localEntry.size,
      remoteSize: remoteEntry.size
    })
  }

  return {
    localRoot,
    remoteRoot,
    entries,
    scanned: remote.entries.length + local.entries.length,
    truncated: remote.truncated || local.truncated,
    excludedDirs: remote.excludedDirs + local.excludedDirs,
    dirsScanned: remote.dirsScanned + local.dirsScanned
  }
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000)
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

export const MISSING_REMOTE_HASH = 'MISSING'

export async function readPair(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  relPath: string
): Promise<FilePair> {
  const localStats = await stat(localPath)
  const remoteStats = await remoteStat(sftp, remotePath)

  if (!remoteStats) {
    const localBuffer = await readFile(localPath)
    const binary = looksBinary(localBuffer)
    const tooLarge = localStats.size > LIMITS.maxDiffBytes
    return {
      relPath,
      localPath,
      remotePath,
      localText: binary || tooLarge ? '' : localBuffer.toString('utf8'),
      remoteText: '',
      localSize: localBuffer.length,
      remoteSize: 0,
      remoteHash: MISSING_REMOTE_HASH,
      remoteMode: 0o644,
      binary,
      tooLarge
    }
  }

  const tooLarge = remoteStats.size > LIMITS.maxDiffBytes || localStats.size > LIMITS.maxDiffBytes
  if (tooLarge) {
    return {
      relPath,
      localPath,
      remotePath,
      localText: '',
      remoteText: '',
      localSize: localStats.size,
      remoteSize: remoteStats.size,
      remoteHash: '',
      remoteMode: remoteStats.mode,
      binary: false,
      tooLarge: true
    }
  }

  const [remoteBuffer, localBuffer] = await Promise.all([remoteReadFile(sftp, remotePath), readFile(localPath)])
  const binary = looksBinary(remoteBuffer) || looksBinary(localBuffer)

  return {
    relPath,
    localPath,
    remotePath,
    localText: binary ? '' : localBuffer.toString('utf8'),
    remoteText: binary ? '' : remoteBuffer.toString('utf8'),
    localSize: localBuffer.length,
    remoteSize: remoteBuffer.length,
    remoteHash: hashBuffer(remoteBuffer),
    remoteMode: remoteStats.mode,
    binary,
    tooLarge: false
  }
}

export { localPathOf }
