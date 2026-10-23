import type { AppApi } from '../../../shared/api'
import { createWebApi } from './web-api'

/** En Electron usa el puente del preload; en el navegador, el WebSocket del servidor. */
export const api: AppApi = window.api ?? createWebApi()
