import type { CompareEntry } from '../../../shared/types'

export interface TreeFileNode {
  kind: 'file'
  name: string
  path: string
  entry: CompareEntry
}

export interface TreeDirNode {
  kind: 'dir'
  name: string
  path: string
  children: TreeNode[]
  /** Archivos en total dentro de la carpeta. */
  files: number
  /** Archivos con diferencias dentro de la carpeta. */
  changes: number
}

export type TreeNode = TreeFileNode | TreeDirNode

interface DirAcc {
  name: string
  path: string
  dirs: Map<string, DirAcc>
  files: TreeFileNode[]
}

/**
 * Construye el árbol a partir de las rutas relativas planas.
 * Las carpetas con un único hijo carpeta se compactan en una sola fila
 * (`.agents/skills/x` en vez de tres niveles vacíos).
 */
export function buildTree(entries: CompareEntry[]): TreeNode[] {
  const root: DirAcc = { name: '', path: '', dirs: new Map(), files: [] }

  for (const entry of entries) {
    const parts = entry.relPath.split('/')
    const fileName = parts.pop() ?? entry.relPath
    let cursor = root
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      let next = cursor.dirs.get(part)
      if (!next) {
        next = { name: part, path: prefix, dirs: new Map(), files: [] }
        cursor.dirs.set(part, next)
      }
      cursor = next
    }
    cursor.files.push({ kind: 'file', name: fileName, path: entry.relPath, entry })
  }

  const toNodes = (acc: DirAcc): { nodes: TreeNode[]; files: number; changes: number } => {
    const dirNodes: TreeDirNode[] = []
    let files = acc.files.length
    let changes = acc.files.filter((file) => file.entry.status !== 'identical').length

    for (const child of [...acc.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const built = toNodes(child)
      files += built.files
      changes += built.changes
      dirNodes.push({
        kind: 'dir',
        name: child.name,
        path: child.path,
        children: built.nodes,
        files: built.files,
        changes: built.changes
      })
    }

    const fileNodes = [...acc.files].sort((a, b) => a.name.localeCompare(b.name))
    return { nodes: [...dirNodes.map(compact), ...fileNodes], files, changes }
  }

  return toNodes(root).nodes
}

/** Une cadenas de carpetas con un solo hijo carpeta y sin archivos propios. */
function compact(node: TreeDirNode): TreeDirNode {
  let current = node
  while (current.children.length === 1) {
    const only = current.children[0]
    if (only.kind !== 'dir') break
    current = {
      kind: 'dir',
      name: `${current.name}/${only.name}`,
      path: only.path,
      children: only.children,
      files: only.files,
      changes: only.changes
    }
  }
  return current
}

/** Todas las rutas de carpeta del árbol, para "expandir todo". */
export function collectDirPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = []
  const walk = (list: TreeNode[]): void => {
    for (const node of list) {
      if (node.kind !== 'dir') continue
      paths.push(node.path)
      walk(node.children)
    }
  }
  walk(nodes)
  return paths
}
