import type {
  AuthChallenge,
  AuditEvent,
  CompareResult,
  ConnectionStatus,
  FilePair,
  HostKeyPrompt,
  OpenTerminalResult,
  RemoteDir,
  ServerInput,
  ServerProfile,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdateState,
  UploadRequest,
  UploadResult
} from './types'

type Unsubscribe = () => void

export interface AppApi {
  servers: {
    list(): Promise<ServerProfile[]>
    save(input: ServerInput): Promise<ServerProfile>
    remove(serverId: string): Promise<boolean>
  }
  audit: {
    list(): Promise<AuditEvent[]>
  }
  connection: {
    connect(serverId: string): Promise<boolean>
    disconnect(serverId: string): Promise<boolean>
    onStatus(handler: (status: ConnectionStatus) => void): Unsubscribe
    onHostKey(handler: (prompt: HostKeyPrompt) => void): Unsubscribe
    onAuthChallenge(handler: (challenge: AuthChallenge) => void): Unsubscribe
    respondAuth(challengeId: string, answer: string): Promise<boolean>
  }
  hostKey: {
    trust(
      serverId: string,
      fingerprint: string,
      algorithm: string,
      host: string,
      port: number
    ): Promise<boolean>
  }
  terminal: {
    open(serverId: string, cols: number, rows: number): Promise<OpenTerminalResult>
    write(terminalId: string, data: string): Promise<boolean>
    resize(terminalId: string, cols: number, rows: number): Promise<boolean>
    close(terminalId: string): Promise<boolean>
    onData(handler: (event: TerminalDataEvent) => void): Unsubscribe
    onExit(handler: (event: TerminalExitEvent) => void): Unsubscribe
  }
  local: {
    pickDirectory(): Promise<string | null>
    pickFile(): Promise<string | null>
  }
  remote: {
    listDirectories(serverId: string, path: string): Promise<RemoteDir[]>
  }
  compare: {
    run(serverId: string, remoteRoot: string, localRoot: string): Promise<CompareResult>
  }
  files: {
    readPair(
      serverId: string,
      remoteRoot: string,
      localRoot: string,
      relPath: string
    ): Promise<FilePair>
    upload(request: UploadRequest): Promise<UploadResult>
  }
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<boolean>
    onState(handler: (state: UpdateState) => void): Unsubscribe
  }
}
