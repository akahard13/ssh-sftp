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
  action: 'connect' | 'disconnect' | 'upload' | 'hostkey-trusted' | 'hostkey-mismatch'
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
