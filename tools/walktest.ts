import { DEFAULT_EXCLUDED_DIRS, LIMITS, walkTree } from '../src/main/ssh/sftp'
import type { WalkedItem } from '../src/main/ssh/sftp'

let failures = 0

function assert(condition: boolean, message: string, extra?: unknown): void {
  if (condition) return
  failures++
  console.error(`FAIL: ${message}`)
  if (extra !== undefined) console.error('  ', JSON.stringify(extra))
}

function file(name: string, size = 10): WalkedItem {
  return { name, isDirectory: false, size, mtime: 1000 }
}

function dir(name: string): WalkedItem {
  return { name, isDirectory: true, size: 0, mtime: 0 }
}

/** Árbol sintético: mapa de ruta absoluta -> contenido del directorio. */
function makeTree(branching: number, depth: number): Record<string, WalkedItem[]> {
  const tree: Record<string, WalkedItem[]> = {}
  const build = (path: string, level: number): void => {
    const items: WalkedItem[] = [file(`${path === '/' ? 'root' : 'file'}-${level}.txt`)]
    if (level < depth) {
      for (let i = 0; i < branching; i++) {
        const name = `d${level}-${i}`
        items.push(dir(name))
        build(`${path === '/' ? '' : path}/${name}`, level + 1)
      }
    }
    // Un node_modules anidado que debe quedar excluido en cualquier nivel.
    items.push(dir('node_modules'))
    tree[path] = items
  }
  build('/', 0)
  return tree
}

function run(
  tree: Record<string, WalkedItem[]>,
  overrides: Partial<Parameters<typeof walkTree>[2]> = {},
  root = '/'
): ReturnType<typeof walkTree> {
  const progress = { dirs: 0, entries: 0 }
  return walkTree(
    root,
    async (abs) => {
      if (!(abs in tree)) throw new Error(`no existe: ${abs}`)
      return tree[abs]
    },
    {
      join: (parent, name) => (parent === '/' ? `/${name}` : `${parent}/${name}`),
      excluded: DEFAULT_EXCLUDED_DIRS,
      shouldCancel: () => false,
      onProgress: (delta) => {
        progress.dirs += delta.dirs ?? 0
        progress.entries += delta.entries ?? 0
      },
      ...overrides
    }
  ).then((output) => ({ output, progress }))
}

async function main(): Promise<void> {
  // 1. Recorrido completo, rutas relativas correctas y exclusiones contadas.
  const shallow = makeTree(2, 2)
  const { output, progress } = await run(shallow)

  const expectedDirs = Object.keys(shallow).length
  assert(output.dirsScanned === expectedDirs, 'se visitan todas las carpetas', {
    got: output.dirsScanned,
    expected: expectedDirs
  })
  assert(output.excludedDirs === expectedDirs, 'cada carpeta tiene un node_modules excluido', {
    got: output.excludedDirs,
    expected: expectedDirs
  })
  assert(
    !output.entries.some((e) => e.relPath.includes('node_modules')),
    'ningun archivo viene de node_modules'
  )
  assert(output.entries.length > 0, 'hay archivos', output.entries.length)
  assert(
    output.entries.every((e) => !e.relPath.startsWith('/')),
    'las rutas son relativas',
    output.entries.slice(0, 3)
  )
  assert(!output.truncated, 'sin truncar')
  assert(progress.dirs === output.dirsScanned, 'progreso de carpetas cuadra')
  assert(progress.entries === output.entries.length, 'progreso de archivos cuadra', {
    progress: progress.entries,
    entries: output.entries.length
  })

  // 2. Tope de entradas.
  const big: Record<string, WalkedItem[]> = {
    '/': [dir('gordo'), file('a.txt')],
    '/gordo': Array.from({ length: LIMITS.maxScanEntries + 500 }, (_, i) => file(`f${i}.txt`))
  }
  const capped = await run(big)
  assert(capped.output.truncated, 'se marca truncado al pasar el tope')
  assert(
    capped.output.entries.length <= LIMITS.maxScanEntries + 1,
    'no se pasa mucho del tope',
    capped.output.entries.length
  )

  // 3. Cancelar: se detiene y devuelve lo recorrido hasta ese momento.
  const wide = makeTree(4, 3)
  let visited = 0
  const cancelled = await run(wide, {
    shouldCancel: () => {
      visited++
      return visited > 3
    }
  })
  const totalDirs = Object.keys(wide).length
  assert(cancelled.output.dirsScanned < totalDirs, 'cancelar reduce el trabajo', {
    scanned: cancelled.output.dirsScanned,
    total: totalDirs
  })

  // 4. Concurrencia: sin ella, un árbol ancho tardaría sumando latencias.
  const slow: Record<string, WalkedItem[]> = { '/': [] }
  const LATENCY = 30
  for (let i = 0; i < 40; i++) {
    slow['/'].push(dir(`slow${i}`))
    slow[`/slow${i}`] = [file(`x${i}.txt`)]
  }
  const started = Date.now()
  const concurrent = await walkTree(
    '/',
    async (abs) => {
      await new Promise((resolve) => setTimeout(resolve, LATENCY))
      return slow[abs] ?? []
    },
    {
      join: (parent, name) => `/${name}`,
      excluded: DEFAULT_EXCLUDED_DIRS,
      shouldCancel: () => false,
      onProgress: () => {}
    }
  )
  const elapsed = Date.now() - started
  const serial = 41 * LATENCY
  assert(concurrent.dirsScanned === 41, 'recorre todas las carpetas lentas', concurrent.dirsScanned)
  assert(elapsed < serial / 2, 'corre en paralelo, no en serie', { elapsed, serial })
  console.log(`  recorrido paralelo: ${elapsed} ms (en serie serian ~${serial} ms)`)

  // 5. Error de lectura: no rompe el recorrido, solo salta esa carpeta.
  const broken = await run({ '/': [dir('ok'), dir('roto')], '/ok': [file('a.txt')] })
  assert(broken.output.entries.length === 1, 'una carpeta ilegible no rompe el recorrido')

  if (failures === 0) console.log('OK: todas las pruebas de recorrido pasaron')
  else {
    console.error(`${failures} fallo(s)`)
    process.exitCode = 1
  }
}

void main()
