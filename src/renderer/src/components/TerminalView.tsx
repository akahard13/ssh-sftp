import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api } from '../lib/api'

interface Entry {
  term: Terminal
  fit: FitAddon
  terminalId: string | null
  serverId: string
}

const cache = new Map<string, Entry>()
const byTerminalId = new Map<string, Terminal>()
/** Salida que llegó antes de asociar el terminalId al xterm (típico en web). */
const pendingData = new Map<string, string[]>()
let dispatcherReady = false

const TERM_THEME = {
  background: '#0d1117',
  foreground: '#d6dae2',
  cursor: '#58a6ff',
  selectionBackground: '#264f78',
  black: '#0d1117',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#d29922',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#76e3ea',
  white: '#d6dae2'
}

function ensureDispatcher(): void {
  if (dispatcherReady) return
  dispatcherReady = true
  api.terminal.onData(({ terminalId, data }) => {
    const term = byTerminalId.get(terminalId)
    if (term) {
      term.write(data)
      return
    }
    const queued = pendingData.get(terminalId) ?? []
    if (queued.length < 200) queued.push(data)
    pendingData.set(terminalId, queued)
  })
  api.terminal.onExit(({ terminalId }) => {
    pendingData.delete(terminalId)
    const term = byTerminalId.get(terminalId)
    if (!term) return
    term.write('\r\n\x1b[90m[sesión finalizada]\x1b[0m\r\n')
    byTerminalId.delete(terminalId)
  })
}

export function disposeTerminal(serverId: string): void {
  const entry = cache.get(serverId)
  if (!entry) return
  if (entry.terminalId) {
    byTerminalId.delete(entry.terminalId)
    pendingData.delete(entry.terminalId)
    void api.terminal.close(entry.terminalId)
  }
  entry.term.dispose()
  cache.delete(serverId)
}

interface TerminalViewProps {
  serverId: string
  visible: boolean
}

export default function TerminalView({ serverId, visible }: TerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ensureDispatcher()
    const host = hostRef.current
    if (!host) return

    let entry = cache.get(serverId)
    if (!entry) {
      const term = new Terminal({
        fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 4000,
        theme: TERM_THEME
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      const created: Entry = { term, fit, terminalId: null, serverId }
      cache.set(serverId, created)
      term.open(host)
      try {
        fit.fit()
      } catch {
        /* container not measured yet */
      }

      api.terminal
        .open(serverId, term.cols, term.rows)
        .then(({ terminalId }) => {
          created.terminalId = terminalId
          byTerminalId.set(terminalId, term)
          const queued = pendingData.get(terminalId)
          if (queued) {
            pendingData.delete(terminalId)
            for (const chunk of queued) term.write(chunk)
          }
          term.onData((data) => {
            if (created.terminalId) void api.terminal.write(created.terminalId, data)
          })
          term.onResize(({ cols, rows }) => {
            if (created.terminalId) void api.terminal.resize(created.terminalId, cols, rows)
          })
          term.focus()
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'No se pudo abrir la terminal.'
          setError(message)
          term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
        })

      entry = created
    } else {
      const existing: Entry = entry
      const element = existing.term.element
      if (element && element.parentElement !== host) {
        host.appendChild(element)
        requestAnimationFrame(() => {
          try {
            existing.fit.fit()
          } catch {
            /* ignore */
          }
          existing.term.focus()
        })
      }
    }

    const active: Entry = entry
    const observer = new ResizeObserver(() => {
      try {
        active.fit.fit()
      } catch {
        /* element hidden */
      }
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [serverId])

  useEffect(() => {
    if (!visible) return
    const entry = cache.get(serverId)
    if (!entry) return
    requestAnimationFrame(() => {
      try {
        entry.fit.fit()
      } catch {
        /* ignore */
      }
      entry.term.focus()
    })
  }, [visible, serverId])

  return (
    <div className="terminal-wrap">
      <div className="terminal-host" ref={hostRef} />
      {error ? <p className="terminal-error">{error}</p> : null}
    </div>
  )
}
