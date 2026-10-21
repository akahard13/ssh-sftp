import { diffLines } from '../src/renderer/src/lib/diff'
import { buildDiff, buildResult, newFileDiff, splitLines } from '../src/renderer/src/lib/merge'

let failures = 0

function assert(condition: boolean, message: string, extra?: unknown): void {
  if (condition) return
  failures++
  console.error(`FAIL: ${message}`)
  if (extra !== undefined) console.error('  ', JSON.stringify(extra))
}

function reconstruct(a: string[], b: string[]): void {
  const ops = diffLines(a, b)
  const fromA = ops.filter((op) => op.type !== 'add').map((op) => op.text)
  const fromB = ops.filter((op) => op.type !== 'del').map((op) => op.text)
  assert(JSON.stringify(fromA) === JSON.stringify(a), 'reconstruccion A', { a, b, fromA })
  assert(JSON.stringify(fromB) === JSON.stringify(b), 'reconstruccion B', { b, fromB })

  let lastA = -1
  let lastB = -1
  for (const op of ops) {
    if (op.type !== 'add') {
      assert(op.aIndex === lastA + 1, 'aIndex consecutivo', { a, b, op, lastA })
      lastA = op.aIndex
    }
    if (op.type !== 'del') {
      assert(op.bIndex === lastB + 1, 'bIndex consecutivo', { a, b, op, lastB })
      lastB = op.bIndex
    }
  }

  const model = buildDiff(a, b, 3)
  const all = new Set(model.hunks.map((h) => h.id))
  const applied = buildResult(a, model.hunks, all)
  assert(applied === b.join('\n'), 'merge todo seleccionado == local', { a, b, applied })
  const none = buildResult(a, model.hunks, new Set())
  assert(none === a.join('\n'), 'merge sin seleccion == remoto', { a, b, none })

  for (let i = 1; i < model.hunks.length; i++) {
    const prev = model.hunks[i - 1]
    const current = model.hunks[i]
    assert(prev.aEnd <= current.aStart, 'hunks en orden por A', { a, b })
    assert(prev.bEnd <= current.bStart, 'hunks en orden por B', { a, b })
  }
}

assert(diffLines([], []).length === 0, 'vacio')

const insert = diffLines(['a', 'c'], ['a', 'b', 'c'])
assert(insert.length === 3, 'insercion: 3 ops', insert)
assert(insert[1].type === 'add', 'insercion: op add', insert)

const del = diffLines(['a', 'b', 'c'], ['a', 'c'])
assert(del.length === 3, 'borrado: 3 ops', del)
assert(del[1].type === 'del', 'borrado: op del', del)

const replace = diffLines(['x'], ['y'])
assert(replace.filter((o) => o.type === 'del').length === 1, 'reemplazo del', replace)
assert(replace.filter((o) => o.type === 'add').length === 1, 'reemplazo add', replace)

const identical = diffLines(['a', 'b'], ['a', 'b'])
assert(
  identical.every((o) => o.type === 'equal'),
  'identico',
  identical
)

reconstruct([], ['x', 'y'])
reconstruct(['x', 'y'], [])
reconstruct(['a'], ['a'])
reconstruct(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'])
reconstruct(['1', '2', '3', '4', '5'], ['1', '3', '5'])
reconstruct(['1', '2', '3'], ['1', '2', '3', '4'])
reconstruct(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'X', 'd', 'Y', 'f', 'g'])

const base = Array.from({ length: 300 }, (_, i) => `linea ${i}`)
const edited = base
  .filter((_, i) => i % 17 !== 0)
  .map((line, i) => (i % 23 === 0 ? `${line} editada` : line))
reconstruct(base, edited)

const alphabet = ['a', 'b', 'c', 'd', 'e']
let seed = 12345
const random = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
for (let round = 0; round < 800; round++) {
  const n = Math.floor(random() * 9)
  const m = Math.floor(random() * 9)
  const a = Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)])
  const b = Array.from({ length: m }, () => alphabet[Math.floor(random() * alphabet.length)])
  reconstruct(a, b)
}

const added = newFileDiff(splitLines('uno\ndos'))
assert(buildResult([], added.hunks, new Set(['hunk-new'])) === 'uno\ndos', 'archivo nuevo completo')
assert(buildResult([], added.hunks, new Set()) === '', 'archivo nuevo sin seleccion')

if (failures === 0) console.log('OK: todas las pruebas de diff/merge pasaron')
else {
  console.error(`${failures} fallo(s)`)
  process.exitCode = 1
}
