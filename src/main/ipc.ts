import { BrowserWindow, dialog, ipcMain } from 'electron'
import { invokeCore } from './services'

/** Canales que atiende el núcleo compartido; los de actualizaciones viven en updater.ts. */
const CORE_CHANNELS = [
  'servers:list',
  'servers:save',
  'servers:delete',
  'audit:list',
  'conn:connect',
  'conn:disconnect',
  'auth:respond',
  'hostkey:trust',
  'term:open',
  'term:write',
  'term:resize',
  'term:close',
  'local:list-dirs',
  'remote:list-dirs',
  'compare:defaults',
  'compare:save-excludes',
  'compare:run',
  'compare:cancel',
  'file:read-pair',
  'file:upload',
  'file:download'
] as const

/**
 * Adaptador de Electron: expone el núcleo compartido por IPC y conserva los
 * diálogos nativos, que en el modo servidor se sustituyen por un explorador web.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  for (const channel of CORE_CHANNELS) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => invokeCore(channel, args))
  }

  ipcMain.handle('local:pick-dir', async () => {
    const window = getWindow()
    const options = {
      title: 'Selecciona el directorio local',
      properties: ['openDirectory', 'createDirectory'] as const
    }
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('local:pick-file', async () => {
    const window = getWindow()
    const options = {
      title: 'Selecciona la llave privada',
      properties: ['openFile', 'showHiddenFiles'] as const
    }
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
