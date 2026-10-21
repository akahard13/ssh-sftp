export interface DiffOp {
  type: 'equal' | 'add' | 'del'
  aIndex: number
  bIndex: number
  text: string
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []

  const max = n + m
  const v = new Map<number, number>()
  v.set(1, 0)
  const trace: Map<number, number>[] = []
  let depth = 0
  let found = false

  for (let d = 0; d <= max && !found; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) {
        depth = d
        found = true
        break
      }
    }
    trace.push(new Map(v))
  }

  const ops: DiffOp[] = []
  let x = n
  let y = m

  for (let d = depth; d > 0; d--) {
    const prev = trace[d - 1]
    const k = x - y
    const down = k === -d || (k !== d && (prev.get(k - 1) ?? 0) < (prev.get(k + 1) ?? 0))
    const prevK = down ? k + 1 : k - 1
    const prevX = prev.get(prevK) ?? 0
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push({ type: 'equal', aIndex: x, bIndex: y, text: a[x] })
    }
    if (x === prevX) {
      y--
      ops.push({ type: 'add', aIndex: x, bIndex: y, text: b[y] })
    } else {
      x--
      ops.push({ type: 'del', aIndex: x, bIndex: y, text: a[x] })
    }
  }

  while (x > 0 && y > 0) {
    x--
    y--
    ops.push({ type: 'equal', aIndex: x, bIndex: y, text: a[x] })
  }

  return ops.reverse()
}

/** Line diff of `a` (base, remote) against `b` (local). */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const middle = myers(midA, midB).map((op) => ({
    ...op,
    aIndex: op.aIndex + prefix,
    bIndex: op.bIndex + prefix
  }))

  const ops: DiffOp[] = []
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: 'equal', aIndex: i, bIndex: i, text: a[i] })
  }
  ops.push(...middle)
  for (let i = 0; i < suffix; i++) {
    const aIndex = a.length - suffix + i
    const bIndex = b.length - suffix + i
    ops.push({ type: 'equal', aIndex, bIndex, text: a[aIndex] })
  }
  return ops
}
