import type { JSX } from 'react'
import type { CompareEntry } from '../../../shared/types'
import { STATUS_LABEL, describeEntry } from '../lib/format'
import type { TreeNode, TreeDirNode } from '../lib/tree'

interface FileTreeProps {
  nodes: TreeNode[]
  activePath: string | null
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (entry: CompareEntry) => void
  /** Sube tal cual el contenido local de todos los archivos de la carpeta. */
  onUploadDir?: (path: string, name: string) => void
  uploading?: boolean
  /** Cuando se indica, cada fila muestra una casilla para elegir qué subir. */
  checked?: ReadonlySet<string>
  onToggleCheck?: (relPath: string) => void
  onToggleDirCheck?: (dirPath: string) => void
  depth?: number
}

function dirCheckState(node: TreeDirNode, checked: ReadonlySet<string>): 'all' | 'some' | 'none' {
  let total = 0
  let on = 0
  const walk = (list: TreeNode[]): void => {
    for (const child of list) {
      if (child.kind === 'file') {
        total += 1
        if (checked.has(child.path)) on += 1
        continue
      }
      walk(child.children)
    }
  }
  walk(node.children)
  if (total === 0 || on === 0) return 'none'
  return on === total ? 'all' : 'some'
}

interface TreeCheckboxProps {
  checked: boolean
  indeterminate: boolean
  label: string
  onChange: () => void
}

function TreeCheckbox({
  checked,
  indeterminate,
  label,
  onChange
}: TreeCheckboxProps): JSX.Element {
  return (
    <input
      type="checkbox"
      className="tree-check"
      checked={checked}
      aria-label={label}
      onChange={onChange}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate
      }}
    />
  )
}

export default function FileTree({
  nodes,
  activePath,
  expanded,
  onToggle,
  onSelect,
  onUploadDir,
  uploading = false,
  checked,
  onToggleCheck,
  onToggleDirCheck,
  depth = 0
}: FileTreeProps): JSX.Element {
  const indent = 6 + depth * 13
  const selectable = checked !== undefined && onToggleCheck !== undefined

  return (
    <ul className="tree">
      {nodes.map((node) => {
        if (node.kind === 'dir') {
          const open = expanded.has(node.path)
          const state = selectable && checked ? dirCheckState(node, checked) : 'none'
          return (
            <li key={node.path}>
              <div className="tree-row dir" style={{ paddingLeft: indent }}>
                {selectable ? (
                  <TreeCheckbox
                    checked={state === 'all'}
                    indeterminate={state === 'some'}
                    label={`Seleccionar todo en ${node.path}`}
                    onChange={() => onToggleDirCheck?.(node.path)}
                  />
                ) : null}
                <button
                  type="button"
                  className="tree-dir-main"
                  onClick={() => onToggle(node.path)}
                  title={node.path}
                >
                  <span className="tree-caret">{open ? '▾' : '▸'}</span>
                  <span className="tree-name">{node.name}</span>
                  <span className="tree-count">
                    {node.changes === node.files ? `${node.files}` : `${node.changes}/${node.files}`}
                  </span>
                </button>
                {onUploadDir ? (
                  <button
                    type="button"
                    className="icon-button tree-upload"
                    onClick={() => onUploadDir(node.path, node.name)}
                    disabled={uploading}
                    title={`Subir todos los archivos de ${node.path}`}
                    aria-label={`Subir todos los archivos de ${node.path}`}
                  >
                    ↑
                  </button>
                ) : null}
              </div>
              {open ? (
                <FileTree
                  nodes={node.children}
                  activePath={activePath}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onUploadDir={onUploadDir}
                  uploading={uploading}
                  checked={checked}
                  onToggleCheck={onToggleCheck}
                  onToggleDirCheck={onToggleDirCheck}
                  depth={depth + 1}
                />
              ) : null}
            </li>
          )
        }

        const isActive = activePath === node.path
        if (!selectable) {
          return (
            <li key={node.path}>
              <button
                type="button"
                className={`tree-row file ${isActive ? 'active' : ''}`}
                style={{ paddingLeft: indent }}
                onClick={() => onSelect(node.entry)}
                title={describeEntry(node.entry)}
              >
                <span className={`status-chip ${node.entry.status}`}>
                  {STATUS_LABEL[node.entry.status]}
                </span>
                <span className="tree-name">{node.name}</span>
              </button>
            </li>
          )
        }

        return (
          <li key={node.path}>
            <div
              className={`tree-row file ${isActive ? 'active' : ''}`}
              style={{ paddingLeft: indent }}
            >
              <TreeCheckbox
                checked={checked?.has(node.path) ?? false}
                indeterminate={false}
                label={`Seleccionar ${node.path}`}
                onChange={() => onToggleCheck?.(node.path)}
              />
              <button
                type="button"
                className="tree-dir-main"
                onClick={() => onSelect(node.entry)}
                title={describeEntry(node.entry)}
              >
                <span className={`status-chip ${node.entry.status}`}>
                  {STATUS_LABEL[node.entry.status]}
                </span>
                <span className="tree-name">{node.name}</span>
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
