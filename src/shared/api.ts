import type {
  AuthChallenge,
  AuditEvent,
  ClientPlatform,
  CompareDefaults,
  CompareProgress,
  CompareResult,
  ConfigImportResult,
  ConnectionStatus,
  DeployHistoryBundle,
  DeployImportResult,
  DeploySession,
  DeploySessionSummary,
  DeployRevertResult,
  DeployStartRequest,
  DownloadRequest,
  DownloadResult,
  FilePair,
  HostKeyPrompt,
  LocalDirListing,
  OpenTerminalResult,
  PathsRequest,
  PathsResult,
  RemoteDir,
  ServerConfigBundle,
  ServerInput,
  ServerProfile,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdateState,
  UploadManyRequest,
  UploadManyResult,
  UploadProgress,
  UploadRequest,
  UploadResult
} from './types'

type Unsubscribe = () => void

export interface AppApi {
  /** Permite a la UI adaptar los selectores de archivos al host. */
  readonly platform: ClientPlatform
  servers: {
    list(): Promise<ServerProfile[]>
    save(input: ServerInput): Promise<ServerProfile>
    remove(serverId: string): Promise<boolean>
  }
  audit: {
    list(): Promise<AuditEvent[]>
  }
  /**
   * Sesiones de despliegue: todo lo subido entre «Iniciar» y «Finalizar» queda
   * registrado en un JSON por sesión. Sin una sesión activa no se puede subir.
   */
  deploy: {
    active(serverId: string): Promise<DeploySessionSummary | null>
    start(request: DeployStartRequest): Promise<DeploySessionSummary>
    end(sessionId: string): Promise<DeploySessionSummary>
    list(): Promise<DeploySessionSummary[]>
    get(sessionId: string): Promise<DeploySession | null>
    /** Restaura en el servidor la versión guardada en el respaldo del archivo. */
    revertFile(sessionId: string, fileId: string): Promise<DeployRevertResult>
    remove(sessionId: string): Promise<boolean>
    /** Consolida todas las sesiones en un único JSON exportable. */
    exportHistory(): Promise<DeployHistoryBundle>
    importHistory(json: string, replace: boolean): Promise<DeployImportResult>
  }
  config: {
    /** Configuración de los servidores registrados, sin secretos. */
    exportServers(): Promise<ServerConfigBundle>
    importServers(json: string, replace: boolean): Promise<ConfigImportResult>
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
    /** Explora el sistema de archivos del equipo que ejecuta el servicio. */
    listDirectories(path: string | null): Promise<LocalDirListing>
  }
  remote: {
    listDirectories(serverId: string, path: string): Promise<RemoteDir[]>
  }
  compare: {
    defaults(): Promise<CompareDefaults>
    saveExcludes(patterns: string[]): Promise<boolean>
    run(
      requestId: string,
      serverId: string,
      remoteRoot: string,
      localRoot: string,
      excluded: string[]
    ): Promise<CompareResult | null>
    cancel(requestId: string): Promise<boolean>
    onProgress(handler: (progress: CompareProgress) => void): Unsubscribe
  }
  files: {
    readPair(
      serverId: string,
      remoteRoot: string,
      localRoot: string,
      relPath: string
    ): Promise<FilePair>
    upload(request: UploadRequest): Promise<UploadResult>
    /** Sube el contenido local de varios archivos (por ejemplo, una carpeta entera). */
    uploadMany(request: UploadManyRequest): Promise<UploadManyResult>
    /** Resuelve rutas pegadas a mano en los archivos locales que contienen. */
    listPaths(request: PathsRequest): Promise<PathsResult>
    onUploadProgress(handler: (progress: UploadProgress) => void): Unsubscribe
    /** Copia al equipo local un archivo que solo existe en el servidor. */
    download(request: DownloadRequest): Promise<DownloadResult>
  }
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<boolean>
    onState(handler: (state: UpdateState) => void): Unsubscribe
  }
}
