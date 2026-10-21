import type { JSX } from 'react'
import type { CompareEntry } from '../../../shared/types'
import { STATUS_LABEL, describeEntry } from '../lib/format'
import type { TreeNode } from '../lib/tree'

interface FileTreeProps {
  nodes: TreeNode[]
  activePath: string | null
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (entry: CompareEntry) => void
  depth?: number
}

export default function FileTree({
  nodes,
  activePath,
  expanded,
  onToggle,
  onSelect,
  depth = 0
}: FileTreeProps): JSX.Element {
  const indent = 6 + depth * 13

  return (
    <ul className="tree">
      {nodes.map((node) => {
        if (node.kind === 'dir') {
          const open = expanded.has(node.path)
          return (
            <li key={node.path}>
              <button
                type="button"
                className="tree-row dir"
                style={{ paddingLeft: indent }}
                onClick={() => onToggle(node.path)}
                title={node.path}
              >
                <span className="tree-caret">{open ? '▾' : '▸'}</span>
                <span className="tree-name">{node.name}</span>
                <span className="tree-count">
                  {node.changes === node.files
                    ? `${node.files}`
                    : `${node.changes}/${node.files}`}
                </span>
              </button>
              {open ? (
                <FileTree
                  nodes={node.children}
                  activePath={activePath}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              ) : null}
            </li>
          )
        }

        return (
          <li key={node.path}>
            <button
              type="button"
              className={`tree-row file ${activePath === node.path ? 'active' : ''}`}
              style={{ paddingLeft: indent }}
              onClick={() => onSelect(node.entry)}
              title={describeEntry(node.entry)}
            >
              <span className={`status-chip ${node.entry.status}`}>{STATUS_LABEL[node.entry.status]}</span>
              <span className="tree-name">{node.name}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
