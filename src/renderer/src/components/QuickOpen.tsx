import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { CompareEntry } from '../../../shared/types'
import { STATUS_LABEL } from '../lib/format'
import { fuzzyMatch } from '../lib/fuzzy'

const MAX_RESULTS = 60

interface QuickOpenProps {
  entries: CompareEntry[]
  onClose: () => void
  onSelect: (entry: CompareEntry) => void
}

interface RankedEntry {
  entry: CompareEntry
  score: number
  indices: number[]
}

/** Divide la ruta en fragmentos normales y resaltados, sin usar HTML crudo. */
function highlight(text: string, indices: number[]): JSX.Element[] {
  if (indices.length === 0) return [<span key={0}>{text}</span>]
  const matched = new Set(indices)
  const parts: JSX.Element[] = []
  let buffer = ''
  let bufferMatched = false

  const flush = (): void => {
    if (buffer.length === 0) return
    const key = parts.length
    parts.push(bufferMatched ? <mark key={key}>{buffer}</mark> : <span key={key}>{buffer}</span>)
    buffer = ''
  }

  for (let i = 0; i < text.length; i += 1) {
    const isMatch = matched.has(i)
    if (isMatch !== bufferMatched) {
      flush()
      bufferMatched = isMatch
    }
    buffer += text[i]
  }
  flush()
  return parts
}

export default function QuickOpen({ entries, onClose, onSelect }: QuickOpenProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const matches = useMemo<RankedEntry[]>(() => {
    const needle = query.trim()
    const ranked: RankedEntry[] = []
    for (const entry of entries) {
      const found = fuzzyMatch(needle, entry.relPath)
      if (!found) continue
      ranked.push({ entry, score: found.score, indices: found.indices })
    }
    if (needle.length > 0) {
      ranked.sort(
        (a, b) =>
          b.score - a.score ||
          a.entry.relPath.length - b.entry.relPath.length ||
          a.entry.relPath.localeCompare(b.entry.relPath)
      )
    }
    return ranked.slice(0, MAX_RESULTS)
  }, [entries, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const list = listRef.current
    const item = list?.children[activeIndex]
    if (item instanceof HTMLElement) item.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, matches])

  const choose = (entry: CompareEntry): void => {
    onSelect(entry)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (matches.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => (current + step + matches.length) % matches.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const active = matches[activeIndex] ?? matches[0]
      if (active) choose(active.entry)
    }
  }

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Buscar archivo"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          className="palette-input"
          autoFocus
          spellCheck={false}
          placeholder="Buscar archivo por ruta…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {matches.length > 0 ? (
          <ul className="palette-list" ref={listRef}>
            {matches.map((item, index) => (
              <li key={item.entry.relPath}>
                <button
                  type="button"
                  className={`palette-item ${index === activeIndex ? 'active' : ''}`}
                  title={item.entry.relPath}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(item.entry)
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className={`status-chip ${item.entry.status}`}>
                    {STATUS_LABEL[item.entry.status]}
                  </span>
                  <span className="palette-path">
                    {highlight(item.entry.relPath, item.indices)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="palette-empty">
            {entries.length === 0
              ? 'Compara las carpetas primero para poder buscar archivos.'
              : 'Ningún archivo coincide con la búsqueda.'}
          </p>
        )}
        <div className="palette-footer">
          <span>
            {entries.length === 0
              ? 'Sin archivos'
              : `${matches.length.toLocaleString('es')} de ${entries.length.toLocaleString('es')} archivo(s)`}
          </span>
          <span className="muted">↑↓ mover · Enter abrir · Esc cerrar</span>
        </div>
      </div>
    </div>
  )
}
