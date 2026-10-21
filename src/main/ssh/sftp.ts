import { posix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'

export interface RemoteWalkEntry {
  relPath: string
  size: number
  mtime: number
}

export interface RemoteStats {
  mode: number
  size: number
  mtime: number
  uid?: number
  gid?: number
}

export interface RemoteDirEntry {
  name: string
  path: string
  isDirectory: boolean
}

type SftpError = Error & { code?: number | string }

export const LIMITS = {
  maxScanEntries: 20000,
  maxHashBytes: 2 * 1024 * 1024,
  maxDiffBytes: 4 * 1024 * 1024,
  maxFileListEntries: 5000
} as const

export function remoteStat(sftp: SFTPWrapper, path: string): Promise<RemoteStats | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) {
        const code = (err as SftpError).code
        if (code === 2 || code === 'ENOENT') resolve(null)
        else reject(err)
        return
      }
      resolve(stats as unknown as RemoteStats)
    })
  })
}

export interface RemoteListItem {
  filename: string
  attrs: {
    size: number
    mtime: number
    mode: number
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
  }
}

export function remoteReaddir(sftp: SFTPWrapper, path: string): Promise<RemoteListItem[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) reject(err)
      else resolve(list as unknown as RemoteListItem[])
    })
  })
}

export function remoteReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

export function remoteRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (err, resolved) => {
      if (err) reject(err)
      else resolve(resolved)
    })
  })
}

function openFile(sftp: SFTPWrapper, path: string, flags: 'r' | 'w' | 'a'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flags, (err, handle) => {
      if (err) reject(err)
      else resolve(handle)
    })
  })
}

function closeFile(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => (err ? reject(err) : resolve()))
  })
}

function writeChunk(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, offset, length, position, (err) => (err ? reject(err) : resolve()))
  })
}

function fsyncFile(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    const candidate = sftp as unknown as {
      fsync?: (h: Buffer, cb: (err?: Error | null) => void) => void
    }
    if (typeof candidate.fsync !== 'function') {
      resolve()
      return
    }
    candidate.fsync(handle, () => resolve())
  })
}

function chmodFile(sftp: SFTPWrapper, path: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(path, mode, (err) => (err ? reject(err) : resolve()))
  })
}

function renamePath(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
  })
}

function extRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ext = (sftp as unknown as { ext_openssh_rename?: unknown }).ext_openssh_rename
    if (typeof ext !== 'function') {
      reject(new Error('ext_openssh_rename no disponible'))
      return
    }
    ;(ext as (a: string, b: string, cb: (err?: Error) => void) => void).call(sftp, from, to, (err) =>
      err ? reject(err) : resolve()
    )
  })
}

export function unlinkSafe(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve) => {
    sftp.unlink(path, () => resolve())
  })
}

/** Escapes a value for safe use inside the allowed remote root. Rejects traversal. */
export function assertInsideRoot(root: string, target: string): string {
  const normalizedRoot = posix.resolve(root)
  const normalizedTarget = posix.resolve(target)
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Ruta fuera del directorio permitido (${normalizedRoot}).`)
  }
  return normalizedTarget
}

export async function listRemoteDirectories(sftp: SFTPWrapper, path: string): Promise<RemoteDirEntry[]> {
  const resolved = await remoteRealpath(sftp, path)
  const list = await remoteReaddir(sftp, resolved)
  return list
    .filter((item) => item.attrs.isDirectory())
    .map((item) => ({
      name: item.filename,
      path: posix.join(resolved, item.filename),
      isDirectory: true
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function walkRemote(
  sftp: SFTPWrapper,
  root: string
): Promise<{ entries: RemoteWalkEntry[]; truncated: boolean }> {
  const entries: RemoteWalkEntry[] = []
  const queue: { abs: string; rel: string }[] = [{ abs: root, rel: '' }]
  let truncated = false

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    let list
    try {
      list = await remoteReaddir(sftp, current.abs)
    } catch {
      continue
    }
    for (const item of list) {
      if (item.filename === '.' || item.filename === '..') continue
      const rel = current.rel ? `${current.rel}/${item.filename}` : item.filename
      const abs = posix.join(current.abs, item.filename)
      if (item.attrs.isDirectory()) {
        queue.push({ abs, rel })
        continue
      }
      if (entries.length >= LIMITS.maxScanEntries) {
        truncated = true
        queue.length = 0
        break
      }
      entries.push({ relPath: rel, size: item.attrs.size, mtime: item.attrs.mtime })
    }
  }
  return { entries, truncated }
}

/** Writes to a temp file in the same directory, then swaps it in. */
export async function atomicUpload(
  sftp: SFTPWrapper,
  remotePath: string,
  content: Buffer,
  backup: boolean
): Promise<{ backupPath: string | null }> {
  const dir = posix.dirname(remotePath)
  const base = posix.basename(remotePath)
  const tmp = posix.join(dir, `.${base}.upload-${Date.now().toString(36)}`)
  const existing = await remoteStat(sftp, remotePath)
  const mode = existing ? existing.mode & 0o777 : 0o644

  try {
    const handle = await openFile(sftp, tmp, 'w')
    try {
      const CHUNK = 32 * 1024
      let offset = 0
      while (offset < content.length) {
        const length = Math.min(CHUNK, content.length - offset)
        await writeChunk(sftp, handle, content, offset, length, offset)
        offset += length
      }
      await fsyncFile(sftp, handle)
    } finally {
      await closeFile(sftp, handle)
    }

    await chmodFile(sftp, tmp, mode)

    if (existing && backup) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
      const backupPath = `${remotePath}.bak-${stamp}`
      await renamePath(sftp, remotePath, backupPath)
      await renamePath(sftp, tmp, remotePath)
      return { backupPath }
    }

    try {
      await extRename(sftp, tmp, remotePath)
    } catch {
      await unlinkSafe(sftp, remotePath)
      await renamePath(sftp, tmp, remotePath)
    }
    return { backupPath: null }
  } catch (err) {
    await unlinkSafe(sftp, tmp)
    throw err
  }
}
