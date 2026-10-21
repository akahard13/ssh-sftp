import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

const INITIAL_DELAY_MS = 15_000
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let state: UpdateState = { status: 'idle', currentVersion: app.getVersion() }
let onChange: ((value: UpdateState) => void) | null = null
let initialized = false
let interval: NodeJS.Timeout | null = null

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, currentVersion: app.getVersion() }
  onChange?.(state)
}

function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/app-update\.yml|ENOENT/i.test(raw)) {
    return 'La app no se compiló con un canal de actualización configurado.'
  }
  if (/401|403|Bad credentials|Unauthorized/i.test(raw)) {
    return 'El repositorio de releases es privado y falta la credencial (variable GH_TOKEN) en este equipo.'
  }
  if (/404/i.test(raw)) {
    return 'No se encontró el release en el repositorio configurado.'
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|getaddrinfo/i.test(raw)) {
    return 'Sin conexión con el servidor de actualizaciones.'
  }
  return raw
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (state.status === 'downloading') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setState({ status: 'error', message: describe(err) })
  }
  return state
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.status !== 'available') return state
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    setState({ status: 'error', message: describe(err) })
  }
  return state
}

export function installUpdate(): void {
  if (state.status !== 'ready') return
  setTimeout(() => autoUpdater.quitAndInstall(), 200)
}

export function getUpdateState(): UpdateState {
  return state
}

export function initUpdater(broadcast: (value: UpdateState) => void): void {
  onChange = broadcast
  if (initialized) return
  initialized = true

  if (!app.isPackaged) {
    setState({
      status: 'unsupported',
      message: 'La auto-actualización solo actúa en la versión instalada.'
    })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', message: undefined }))
  autoUpdater.on('update-available', (info) => {
    setState({ status: 'available', version: info.version, message: undefined })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ status: 'none', message: 'Estás en la última versión.', percent: undefined })
  })
  autoUpdater.on('download-progress', (progress) => {
    setState({ status: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setState({
      status: 'ready',
      version: info.version,
      percent: 100,
      message: 'Reinicia para aplicar la actualización.'
    })
  })
  autoUpdater.on('error', (err) => {
    setState({ status: 'error', message: describe(err) })
  })

  const start = (): void => {
    void checkForUpdates()
    interval = setInterval(() => void checkForUpdates(), RECHECK_INTERVAL_MS)
  }
  const timer = setTimeout(start, INITIAL_DELAY_MS)
  app.on('before-quit', () => {
    clearTimeout(timer)
    if (interval) clearInterval(interval)
  })
}

export function registerUpdaterIpc(getWindow: () => BrowserWindow | null): void {
  initUpdater((value) => getWindow()?.webContents.send('evt:update-state', value))

  ipcMain.handle('updates:state', () => getUpdateState())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:download', () => downloadUpdate())
  ipcMain.handle('updates:install', () => {
    installUpdate()
    return true
  })
}
