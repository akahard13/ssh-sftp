import { buildTree, collectDirPaths } from '../src/renderer/src/lib/tree'
import type { TreeNode } from '../src/renderer/src/lib/tree'
import type { CompareEntry, CompareStatus } from '../src/shared/types'

let failures = 0

function assert(condition: boolean, message: string, extra?: unknown): void {
  if (condition) return
  failures++
  console.error(`FAIL: ${message}`)
  if (extra !== undefined) console.error('  ', JSON.stringify(extra, null, 2))
}

function entry(relPath: string, status: CompareStatus = 'modified'): CompareEntry {
  return { relPath, status, isDirectory: false, localSize: 10, remoteSize: 5 }
}

function names(nodes: TreeNode[]): string[] {
  return nodes.map((node) => (node.kind === 'dir' ? `dir:${node.name}` : `file:${node.name}`))
}

// 1. Archivo suelto.
const flat = buildTree([entry('index.php')])
assert(flat.length === 1, 'un archivo -> un nodo', names(flat))
assert(flat[0].kind === 'file' && flat[0].name === 'index.php', 'nombre del archivo', names(flat))

// 2. Carpetas encadenadas se compactan en una sola fila.
const deep = buildTree([entry('app/Http/Controllers/A.php')])
assert(deep.length === 1, 'una sola fila para la cadena de carpetas', names(deep))
assert(deep[0].kind === 'dir', 'el nodo raiz es carpeta', names(deep))
assert(
  deep[0].kind === 'dir' && deep[0].name === 'app/Http/Controllers',
  'nombre compactado',
  names(deep)
)
assert(
  deep[0].kind === 'dir' && deep[0].path === 'app/Http/Controllers',
  'la ruta sigue siendo la mas profunda',
  deep[0]
)
assert(
  deep[0].kind === 'dir' && deep[0].children.length === 1,
  'el hijo es el archivo',
  deep[0].kind === 'dir' ? names(deep[0].children) : null
)

// 3. La compactación se detiene si hay ramas.
const branched = buildTree([entry('a/b1/f.txt'), entry('a/b2/g.txt')])
assert(branched[0].kind === 'dir' && branched[0].name === 'a', 'no compacta si hay ramas', names(branched))
assert(
  branched[0].kind === 'dir' && names(branched[0].children).join('|') === 'dir:b1|dir:b2',
  'dos carpetas hijas',
  branched[0].kind === 'dir' ? names(branched[0].children) : null
)

// 4. La compactación se detiene si el nivel tiene archivos propios.
const withFile = buildTree([entry('a/x.txt'), entry('a/b/f.txt')])
assert(withFile[0].kind === 'dir' && withFile[0].name === 'a', 'no compacta si hay archivos propios', names(withFile))
assert(
  withFile[0].kind === 'dir' && names(withFile[0].children).join('|') === 'dir:b|file:x.txt',
  'carpetas antes que archivos',
  withFile[0].kind === 'dir' ? names(withFile[0].children) : null
)

// 5. Conteos de archivos y de diferencias.
const counts = buildTree([entry('a/b/f1.txt', 'modified'), entry('a/b/f2.txt', 'identical')])
const dirNode = counts[0]
assert(
  dirNode.kind === 'dir' && dirNode.files === 2 && dirNode.changes === 1,
  'cuenta archivos y diferencias',
  dirNode
)

// 6. Orden: carpetas primero, luego archivos, alfabetico.
const ordered = buildTree([entry('z.txt'), entry('m.txt'), entry('b/g.txt'), entry('a/h.txt')])
assert(
  names(ordered).join('|') === 'dir:a|dir:b|file:m.txt|file:z.txt',
  'orden carpetas y archivos',
  names(ordered)
)

// 7. collectDirPaths incluye todos los niveles.
const paths = collectDirPaths(branched)
assert(paths.length === 3, 'tres carpetas', paths)
assert(paths.includes('a') && paths.includes('a/b1'), 'incluye niveles', paths)

// 8. Lista vacía.
assert(buildTree([]).length === 0, 'sin entradas -> sin nodos')

if (failures === 0) console.log('OK: todas las pruebas del arbol pasaron')
else {
  console.error(`${failures} fallo(s)`)
  process.exitCode = 1
}
