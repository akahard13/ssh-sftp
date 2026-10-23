import { app, BrowserWindow, shell } from 'electron'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { electronSecretCodec } from './secret'
import { disposeServices, initServices } from './services'
import { registerUpdaterIpc } from './updater'

const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(RENDERER_DEV_URL)

let mainWindow: BrowserWindow | null = null

/**
 * La app se llamaba "ssh-sftp-manager": al renombrarla cambia `userData`, así
 * que se migran los datos (perfiles, secretos, known_hosts y auditoría) y la
 * llave de OSCrypt la primera vez. Esa llave vive en `<userData>/Local State` y
 * es la única que descifra los secretos de `safeStorage`; sin ella
 * `decryptString` falla y las contraseñas guardadas se pierden. Se ejecuta
 * antes de `app.whenReady()` para que Electron lea la llave migrada.
 */
const LEGACY_USER_DATA = ['ssh-sftp-manager', 'SSH SFTP Manager']

function migrateLegacyUserData(): void {
  const userData = app.getPath('userData')
  const currentData = join(userData, 'data')
  if (existsSync(currentData)) return
  for (const name of LEGACY_USER_DATA) {
    const legacyRoot = join(app.getPath('appData'), name)
    const legacyData = join(legacyRoot, 'data')
    if (!existsSync(legacyData)) continue
    try {
      mkdirSync(dirname(currentData), { recursive: true })
      const legacyLocalState = join(legacyRoot, 'Local State')
      if (existsSync(legacyLocalState)) cpSync(legacyLocalState, join(userData, 'Local State'))
      cpSync(legacyData, currentData, { recursive: true })
    } catch (err) {
      console.error('No se pudieron migrar los datos anteriores:', err)
    }
    return
  }
}

migrateLegacyUserData()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1319',
    title: 'DeploySync',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: isDev
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && RENDERER_DEV_URL ? url.startsWith(RENDERER_DEV_URL) : false
    if (!allowed) event.preventDefault()
  })

  window.on('closed', () => {
    mainWindow = null
  })

  if (isDev && RENDERER_DEV_URL) {
    void window.loadURL(RENDERER_DEV_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })

  app.whenReady().then(async () => {
    await initServices({
      dataDir: join(app.getPath('userData'), 'data'),
      secrets: electronSecretCodec,
      emitter: (channel, payload) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(channel, payload)
        }
      }
    })
    registerIpc(() => mainWindow)
    registerUpdaterIpc(() => mainWindow)
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    void disposeServices()
  })
}
