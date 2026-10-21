import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join} from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { CompareEntry, CompareResult, CompareStatus, FilePair } from '../../shared/types'
import { LIMITS, remoteReadFile, remoteStat, walkRemote } from './sftp'

interface LocalWalkEntry {
  relPath: string
  size: number
}

async function walkLocal(root: string): Promise<{ entries: LocalWalkEntry[]; truncated: boolean }> {
  const entries: LocalWalkEntry[] = []
  const queue: { abs: string; rel: string }[] = [{ abs: root, rel: '' }]
  let truncated = false

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    let list
    try {
      list = await readdir(current.abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of list) {
      const rel = current.rel ? `${current.rel}/${item.name}` : item.name
      const abs = join(current.abs, item.name)
      if (item.isDirectory()) {
        queue.push({ abs, rel })
        continue
      }
      if (!item.isFile()) continue
      if (entries.length >= LIMITS.maxScanEntries) {
        truncated = true
        queue.length = 0
        break
      }
      try {
        const info = await stat(abs)
        entries.push({ relPath: rel, size: info.size })
      } catch {
        /* unreadable file, skip */
      }
    }
  }
  return { entries, truncated }
}

export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function hashLocalFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function hashRemoteFile(sftp: SFTPWrapper, path: string): Promise<string | null> {
  try {
    return hashBuffer(await remoteReadFile(sftp, path))
  } catch {
    return null
  }
}

function localPathOf(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'))
}

export async function compareDirectories(
  sftp: SFTPWrapper,
  remoteRoot: string,
  localRoot: string
): Promise<CompareResult> {
  const [remote, local] = await Promise.all([walkRemote(sftp, remoteRoot), walkLocal(localRoot)])
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

    let status: CompareStatus = 'modified'
    if (remoteEntry.size === localEntry.size) {
      if (remoteEntry.size <= LIMITS.maxHashBytes) {
        const [remoteHash, localHash] = await Promise.all([
          hashRemoteFile(sftp, `${remoteRoot}/${relPath}`),
          hashLocalFile(localPathOf(localRoot, relPath)).catch(() => null)
        ])
        status = remoteHash && localHash && remoteHash === localHash ? 'identical' : 'modified'
      } else {
        status = 'same-size'
      }
    }

    entries.push({
      relPath,
      status,
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
    truncated: remote.truncated || local.truncated
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
