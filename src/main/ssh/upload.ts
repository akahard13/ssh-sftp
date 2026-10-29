import { readFile, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { UploadManyError } from '../../shared/types'
import { hashBuffer } from './compare'
import { alongsideBackupPath, atomicUpload, remoteReadFile, remoteStat } from './sftp'

export interface UploadTarget {
  /** Ruta relativa, tal como se muestra en la comparación. */
  relPath: string
  remotePath: string
  localPath: string
}

export interface UploadTargetsOptions {
  /** Respaldo `.bak-<fecha>` junto a cada archivo remoto reemplazado. */
  backup: boolean
  /**
   * Carpeta remota donde se mueve la versión anterior de cada archivo
   * reemplazado, conservando su ruta relativa.
   */
  backupDir?: string | null
  /** Tope por archivo; lo aplica quien llama para no leer archivos enormes. */
  maxBytes: number
  concurrency?: number
  onProgress?: (done: number, total: number) => void
}

export interface UploadTargetsResult {
  uploaded: number
  skipped: number
  bytes: number
  errors: UploadManyError[]
  backupRoot: string | null
}

const DEFAULT_CONCURRENCY = 4

/**
 * Sube tal cual el contenido local de cada destino. Los archivos idénticos al
 * remoto se omiten y los errores se acumulan para no abortar la tanda entera.
 */
export async function uploadTargets(
  sftp: SFTPWrapper,
  targets: readonly UploadTarget[],
  options: UploadTargetsOptions
): Promise<UploadTargetsResult> {
  const total = targets.length
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, total))
  const backupDir = options.backupDir ?? null
  let done = 0
  let cursor = 0
  let uploaded = 0
  let skipped = 0
  let bytes = 0
  const errors: UploadManyError[] = []

  const worker = async (): Promise<void> => {
    for (;;) {
      const target = targets[cursor]
      cursor += 1
      if (!target) return
      try {
        const localInfo = await stat(target.localPath).catch(() => null)
        if (!localInfo?.isFile()) throw new Error('El archivo ya no existe en local.')
        if (localInfo.size > options.maxBytes) {
          throw new Error('Excede el tamaño permitido para subir.')
        }
        const payload = await readFile(target.localPath)
        const remoteInfo = await remoteStat(sftp, target.remotePath)
        if (remoteInfo && remoteInfo.size === payload.length) {
          const same = hashBuffer(await remoteReadFile(sftp, target.remotePath)) === hashBuffer(payload)
          if (same) {
            skipped += 1
            continue
          }
        }
        const backupPath = backupDir
          ? posix.join(backupDir, target.relPath)
          : options.backup
            ? alongsideBackupPath(target.remotePath)
            : null
        await atomicUpload(sftp, target.remotePath, payload, backupPath)
        uploaded += 1
        bytes += payload.length
      } catch (err) {
        errors.push({
          relPath: target.relPath,
          message: err instanceof Error ? err.message : 'Error desconocido.'
        })
      } finally {
        done += 1
        options.onProgress?.(done, total)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return { uploaded, skipped, bytes, errors, backupRoot: backupDir }
}
