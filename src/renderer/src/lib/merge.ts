import { diffLines } from './diff'

export interface Hunk {
  id: string
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
  remoteLines: string[]
  localLines: string[]
}

export type DisplayRow =
  | { kind: 'equal'; key: string; aNo: number; bNo: number; text: string }
  | {
      kind: 'change'
      key: string
      hunkId: string
      del: { no: number; text: string } | null
      add: { no: number; text: string } | null
    }
  | { kind: 'collapse'; key: string; count: number }

export interface DiffModel {
  rows: DisplayRow[]
  hunks: Hunk[]
}

export function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n')
}

/**
 * Builds the display rows and the list of selectable hunks.
 * `remoteLines` is the base (what lives on the server), `localLines` is the local version.
 */
export function buildDiff(remoteLines: string[], localLines: string[], context = 3): DiffModel {
  const ops = diffLines(remoteLines, localLines)
  const rows: DisplayRow[] = []
  const hunks: Hunk[] = []
  let index = 0
  let hunkCounter = 0
  let rowCounter = 0

  while (index < ops.length) {
    if (ops[index].type === 'equal') {
      let end = index
      while (end < ops.length && ops[end].type === 'equal') end++
      const run = ops.slice(index, end)
      if (run.length > context * 2 + 2) {
        for (const op of run.slice(0, context)) {
          rows.push({
            kind: 'equal',
            key: `r${rowCounter++}`,
            aNo: op.aIndex + 1,
            bNo: op.bIndex + 1,
            text: op.text
          })
        }
        rows.push({ kind: 'collapse', key: `c${rowCounter++}`, count: run.length - context * 2 })
        for (const op of run.slice(run.length - context)) {
          rows.push({
            kind: 'equal',
            key: `r${rowCounter++}`,
            aNo: op.aIndex + 1,
            bNo: op.bIndex + 1,
            text: op.text
          })
        }
      } else {
        for (const op of run) {
          rows.push({
            kind: 'equal',
            key: `r${rowCounter++}`,
            aNo: op.aIndex + 1,
            bNo: op.bIndex + 1,
            text: op.text
          })
        }
      }
      index = end
      continue
    }

    let end = index
    while (end < ops.length && ops[end].type !== 'equal') end++
    const run = ops.slice(index, end)
    const deletions = run.filter((op) => op.type === 'del')
    const additions = run.filter((op) => op.type === 'add')
    const aStart = run[0].aIndex
    const bStart = run[0].bIndex
    const hunk: Hunk = {
      id: `hunk-${hunkCounter++}`,
      aStart,
      aEnd: aStart + deletions.length,
      bStart,
      bEnd: bStart + additions.length,
      remoteLines: remoteLines.slice(aStart, aStart + deletions.length),
      localLines: localLines.slice(bStart, bStart + additions.length)
    }
    hunks.push(hunk)

    const count = Math.max(deletions.length, additions.length)
    for (let k = 0; k < count; k++) {
      const del = deletions[k]
      const add = additions[k]
      rows.push({
        kind: 'change',
        key: `r${rowCounter++}`,
        hunkId: hunk.id,
        del: del ? { no: del.aIndex + 1, text: del.text } : null,
        add: add ? { no: add.bIndex + 1, text: add.text } : null
      })
    }
    index = end
  }

  return { rows, hunks }
}

/** A file that does not exist on the server yet: one hunk that adds every line. */
export function newFileDiff(localLines: string[]): DiffModel {
  const hunk: Hunk = {
    id: 'hunk-new',
    aStart: 0,
    aEnd: 0,
    bStart: 0,
    bEnd: localLines.length,
    remoteLines: [],
    localLines
  }
  const rows: DisplayRow[] = localLines.map((text, i) => ({
    kind: 'change' as const,
    key: `r${i}`,
    hunkId: hunk.id,
    del: null,
    add: { no: i + 1, text }
  }))
  return { rows, hunks: [hunk] }
}

/** Applies the selected hunks on top of the remote content. */
export function buildResult(
  remoteLines: string[],
  hunks: Hunk[],
  selected: ReadonlySet<string>
): string {
  const output: string[] = []
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.aStart > cursor) output.push(...remoteLines.slice(cursor, hunk.aStart))
    output.push(...(selected.has(hunk.id) ? hunk.localLines : hunk.remoteLines))
    cursor = hunk.aEnd
  }
  if (cursor < remoteLines.length) output.push(...remoteLines.slice(cursor))
  return output.join('\n')
}

export function countChanges(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    added += hunk.localLines.length
    removed += hunk.remoteLines.length
  }
  return { added, removed }
}
