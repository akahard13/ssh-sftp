import type { CompareEntry, CompareStatus } from '../../../shared/types'

export const STATUS_LABEL: Record<CompareStatus, string> = {
  'local-only': 'solo local',
  'remote-only': 'solo servidor',
  modified: 'distinto',
  identical: 'igual',
  'same-size': 'mismo tamaño'
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function describeEntry(entry: CompareEntry): string {
  return `${entry.relPath} · local ${formatSize(entry.localSize)} · servidor ${formatSize(entry.remoteSize)}`
}
