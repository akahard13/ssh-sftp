import type { AppApi } from '../shared/api'

declare global {
  interface Window {
    /** Solo existe cuando la ventana corre dentro de Electron. */
    api?: AppApi
  }
}

export {}
