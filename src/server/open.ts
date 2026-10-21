import { spawn } from 'node:child_process'

/** Abre una URL en el navegador del host; los fallos se ignoran a propósito. */
export function openUrl(url: string): void {
  const platform = process.platform
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      /* sin navegador disponible (servidor headless) */
    })
    child.unref()
  } catch {
    /* ignore */
  }
}
