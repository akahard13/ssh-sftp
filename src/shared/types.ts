export type AuthMethod = 'password' | 'key' | 'agent'

export interface JumpHost {
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath: string | null
}

export interface ServerProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath: string | null
  remoteRoot: string | null
  localRoot: string | null
  jumpHost: JumpHost | null
  /** True when an encrypted secret is stored for this server. */
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface ServerInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath: string | null
  remoteRoot: string | null
  localRoot: string | null
  jumpHost: JumpHost | null
  /** Plaintext secret, only travels from the UI to the main process. Omit to keep the stored one. */
  secret?: string | null
  /** Set to true to delete the stored secret. */
  clearSecret?: boolean
}

export type ConnectionState = 'disconnected' | 'connecting' | 'ready' | 'error' | 'needs-auth'

export interface ConnectionStatus {
  serverId: string
  state: ConnectionState
  message?: string
}

export interface HostKeyPrompt {
  serverId: string
  host: string
  port: number
  fingerprint: string
  algorithm: string
  kind: 'unknown' | 'mismatch'
  previousFingerprint?: string
}

export interface AuthChallenge {
  challengeId: string
  serverId: string
  prompt: string
  echo: boolean
}

export interface RemoteEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number
  mode: number
}

export interface RemoteDir {
  name: string
  path: string
  isDirectory: boolean
}

/** Entrada del explorador de rutas del equipo que ejecuta la app. */
export interface LocalEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface LocalDirListing {
  path: string
  parent: string | null
  entries: LocalEntry[]
}

/** El escritorio usa Electron; el modo servidor corre en un navegador. */
export type ClientPlatform = 'desktop' | 'web'

export type CompareStatus = 'local-only' | 'remote-only' | 'modified' | 'identical' | 'same-size'

export interface CompareEntry {
  relPath: string
  status: CompareStatus
  isDirectory: boolean
  localSize: number | null
  remoteSize: number | null
}

export interface CompareResult {
  localRoot: string
  remoteRoot: string
  entries: CompareEntry[]
  scanned: number
  truncated: boolean
  /** Elementos omitidos por los patrones de exclusión (carpetas y archivos). */
  excludedDirs: number
  excludedFiles: number
  dirsScanned: number
}

export interface CompareDefaults {
  defaults: string[]
  saved: string[] | null
}

export interface CompareProgress {
  requestId: string
  phase: 'walking-remote' | 'walking-local'
  dirs: number
  entries: number
}

export interface FilePair {
  relPath: string
  localPath: string
  remotePath: string
  localText: string
  remoteText: string
  localSize: number
  remoteSize: number
  remoteHash: string
  remoteMode: number
  binary: boolean
  tooLarge: boolean
  /** El archivo existe en el servidor pero no en local. */
  localMissing: boolean
}

export interface UploadRequest {
  serverId: string
  remotePath: string
  content: string
  /** Hash of the remote file the merge was based on; guards against concurrent edits. */
  expectedRemoteHash: string
  backup: boolean
}

export interface UploadResult {
  ok: boolean
  bytes: number
  remotePath: string
  backupPath: string | null
}

export interface UploadManyRequest {
  /** Identifica la tanda para los eventos de progreso. */
  requestId: string
  serverId: string
  remoteRoot: string
  localRoot: string
  /** Rutas relativas que se suben tal cual están en el disco local. */
  relPaths: string[]
  /** Crea un `.bak-<fecha>` junto a cada archivo remoto reemplazado. */
  backup: boolean
  /**
   * Carpeta, relativa a `remoteRoot`, donde se guarda la versión remota anterior
   * con la misma estructura de rutas. Sustituye al `.bak` de `backup`.
   */
  backupFolder?: string | null
}

export interface UploadManyError {
  relPath: string
  message: string
}

export interface UploadManyResult {
  ok: boolean
  uploaded: number
  skipped: number
  bytes: number
  errors: UploadManyError[]
  /** Carpeta remota donde quedó el respaldo, si se pidió alguno. */
  backupRoot?: string | null
}

/** Rutas pegadas por el usuario para listar y subir archivos concretos. */
export interface PathsRequest {
  serverId: string
  remoteRoot: string
  localRoot: string
  /** Rutas relativas a `localRoot` o absolutas del equipo local. */
  paths: string[]
}

export interface PathsError {
  /** Ruta tal como la escribió el usuario. */
  path: string
  message: string
}

export interface PathsResult {
  entries: CompareEntry[]
  errors: PathsError[]
  /** Se alcanzó el tope de archivos y quedaron rutas sin procesar. */
  truncated: boolean
}

export interface UploadProgress {
  requestId: string
  done: number
  total: number
}

export interface DownloadRequest {
  serverId: string
  remoteRoot: string
  localRoot: string
  relPath: string
}

export interface DownloadResult {
  ok: boolean
  bytes: number
  localPath: string
}

export interface OpenTerminalResult {
  terminalId: string
  serverId: string
}

export interface TerminalDataEvent {
  terminalId: string
  data: string
}

export interface TerminalExitEvent {
  terminalId: string
  code: number | undefined
}

export interface AuditEvent {
  at: string
  serverId: string
  serverName: string
  action: 'connect' | 'disconnect' | 'upload' | 'download' | 'hostkey-trusted' | 'hostkey-mismatch'
  detail: string
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'none'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  version?: string
  percent?: number
  message?: string
}
