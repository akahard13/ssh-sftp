import { contextBridge, ipcRenderer } from 'electron'
import type { AppApi } from '../shared/api'
import type {
  AuthChallenge,
  CompareProgress,
  CompareResult,
  ConnectionStatus,
  FilePair,
  HostKeyPrompt,
  OpenTerminalResult,
  RemoteDir,
  ServerInput,
  ServerProfile,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdateState,
  UploadRequest,
  UploadResult
} from '../shared/types'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: AppApi = {
  servers: {
    list: (): Promise<ServerProfile[]> => ipcRenderer.invoke('servers:list'),
    save: (input: ServerInput): Promise<ServerProfile> => ipcRenderer.invoke('servers:save', input),
    remove: (serverId: string): Promise<boolean> => ipcRenderer.invoke('servers:delete', serverId)
  },
  audit: {
    list: (): Promise<import('../shared/types').AuditEvent[]> => ipcRenderer.invoke('audit:list')
  },
  connection: {
    connect: (serverId: string): Promise<boolean> => ipcRenderer.invoke('conn:connect', serverId),
    disconnect: (serverId: string): Promise<boolean> => ipcRenderer.invoke('conn:disconnect', serverId),
    onStatus: (handler: (status: ConnectionStatus) => void): (() => void) =>
      subscribe('evt:conn-status', handler),
    onHostKey: (handler: (prompt: HostKeyPrompt) => void): (() => void) =>
      subscribe('evt:hostkey', handler),
    onAuthChallenge: (handler: (challenge: AuthChallenge) => void): (() => void) =>
      subscribe('evt:auth-challenge', handler),
    respondAuth: (challengeId: string, answer: string): Promise<boolean> =>
      ipcRenderer.invoke('auth:respond', challengeId, answer)
  },
  hostKey: {
    trust: (
      serverId: string,
      fingerprint: string,
      algorithm: string,
      host: string,
      port: number
    ): Promise<boolean> =>
      ipcRenderer.invoke('hostkey:trust', serverId, fingerprint, algorithm, host, port)
  },
  terminal: {
    open: (serverId: string, cols: number, rows: number): Promise<OpenTerminalResult> =>
      ipcRenderer.invoke('term:open', serverId, cols, rows),
    write: (terminalId: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke('term:write', terminalId, data),
    resize: (terminalId: string, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke('term:resize', terminalId, cols, rows),
    close: (terminalId: string): Promise<boolean> => ipcRenderer.invoke('term:close', terminalId),
    onData: (handler: (event: TerminalDataEvent) => void): (() => void) =>
      subscribe('evt:term-data', handler),
    onExit: (handler: (event: TerminalExitEvent) => void): (() => void) =>
      subscribe('evt:term-exit', handler)
  },
  local: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('local:pick-dir'),
    pickFile: (): Promise<string | null> => ipcRenderer.invoke('local:pick-file')
  },
  remote: {
    listDirectories: (serverId: string, path: string): Promise<RemoteDir[]> =>
      ipcRenderer.invoke('remote:list-dirs', serverId, path)
  },
  compare: {
    run: (
      requestId: string,
      serverId: string,
      remoteRoot: string,
      localRoot: string
    ): Promise<CompareResult | null> =>
      ipcRenderer.invoke('compare:run', requestId, serverId, remoteRoot, localRoot),
    cancel: (requestId: string): Promise<boolean> => ipcRenderer.invoke('compare:cancel', requestId),
    onProgress: (handler: (progress: CompareProgress) => void): (() => void) =>
      subscribe('evt:compare-progress', handler)
  },
  files: {
    readPair: (
      serverId: string,
      remoteRoot: string,
      localRoot: string,
      relPath: string
    ): Promise<FilePair> =>
      ipcRenderer.invoke('file:read-pair', serverId, remoteRoot, localRoot, relPath),
    upload: (request: UploadRequest): Promise<UploadResult> => ipcRenderer.invoke('file:upload', request)
  },
  updates: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('updates:state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('updates:check'),
    download: (): Promise<UpdateState> => ipcRenderer.invoke('updates:download'),
    install: (): Promise<boolean> => ipcRenderer.invoke('updates:install'),
    onState: (handler: (state: UpdateState) => void): (() => void) =>
      subscribe('evt:update-state', handler)
  }
}

export type { AppApi } from '../shared/api'

contextBridge.exposeInMainWorld('api', api)
