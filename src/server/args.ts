import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ServerCliOptions {
  host: string
  port: number
  dataDir: string
  webDir: string
  token: string | null
  openBrowser: boolean
  tlsCert: string | null
  tlsKey: string | null
  trustProxy: boolean
  help: boolean
  versionRequested: boolean
}

export const DEFAULT_PORT = 7777
export const MIN_TOKEN_LENGTH = 16

export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(base, 'ssh-sftp-manager')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'ssh-sftp-manager')
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'ssh-sftp-manager')
}

function defaultWebDir(): string {
  // El CLI se compila a out/server/cli.js y sirve out/web.
  return resolve(__dirname, '..', 'web')
}

function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback
}

function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase())
}

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): ServerCliOptions {
  const options: ServerCliOptions = {
    host: env.SSH_SFTP_HOST || '127.0.0.1',
    port: numberFromEnv(env.SSH_SFTP_PORT ?? env.PORT, DEFAULT_PORT),
    dataDir: resolve(env.SSH_SFTP_DATA_DIR || defaultDataDir()),
    webDir: resolve(env.SSH_SFTP_WEB_DIR || defaultWebDir()),
    token: env.SSH_SFTP_TOKEN || null,
    openBrowser: boolFromEnv(env.SSH_SFTP_OPEN, true),
    tlsCert: env.SSH_SFTP_TLS_CERT || null,
    tlsKey: env.SSH_SFTP_TLS_KEY || null,
    trustProxy: boolFromEnv(env.SSH_SFTP_TRUST_PROXY, false),
    help: false,
    versionRequested: false
  }

  const takeValue = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) return [inline, index]
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('-')) {
      throw new CliError(`Falta el valor de ${flag}.`)
    }
    return [next, index + 1]
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)

    switch (name) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '-v':
      case '--version':
        options.versionRequested = true
        break
      case '--host':
      case '-H': {
        const [value, next] = takeValue(name, inline, i)
        options.host = value
        i = next
        break
      }
      case '--port':
      case '-p': {
        const [value, next] = takeValue(name, inline, i)
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new CliError('El puerto debe ser un número entre 0 y 65535.')
        }
        options.port = port
        i = next
        break
      }
      case '--data-dir':
      case '-d': {
        const [value, next] = takeValue(name, inline, i)
        options.dataDir = resolve(value)
        i = next
        break
      }
      case '--web-dir':
      case '-w': {
        const [value, next] = takeValue(name, inline, i)
        options.webDir = resolve(value)
        i = next
        break
      }
      case '--token':
      case '-t': {
        const [value, next] = takeValue(name, inline, i)
        options.token = value
        i = next
        break
      }
      case '--tls-cert': {
        const [value, next] = takeValue(name, inline, i)
        options.tlsCert = resolve(value)
        i = next
        break
      }
      case '--tls-key': {
        const [value, next] = takeValue(name, inline, i)
        options.tlsKey = resolve(value)
        i = next
        break
      }
      case '--trust-proxy':
        options.trustProxy = true
        break
      case '--no-open':
        options.openBrowser = false
        break
      case '--open':
        options.openBrowser = true
        break
      default:
        throw new CliError(`Opción desconocida: ${arg}`)
    }
  }

  if ((options.tlsCert === null) !== (options.tlsKey === null)) {
    throw new CliError('--tls-cert y --tls-key deben indicarse juntos.')
  }
  if (options.token !== null && options.token.length < MIN_TOKEN_LENGTH) {
    throw new CliError(`El token debe tener al menos ${MIN_TOKEN_LENGTH} caracteres.`)
  }
  if (options.host.trim().length === 0) {
    throw new CliError('El host no puede estar vacío.')
  }
  return options
}

export function helpText(version: string): string {
  return `SSH · SFTP Manager v${version} — modo servidor web

Uso:
  ssh-sftp-manager [opciones]
  npx ssh-sftp-manager [opciones]

Opciones:
  -H, --host <host>        Interfaz donde escuchar (por defecto 127.0.0.1).
                           Usa 0.0.0.0 para acceder desde otros dispositivos.
  -p, --port <puerto>      Puerto HTTP/HTTPS (por defecto ${DEFAULT_PORT}, 0 = aleatorio).
  -d, --data-dir <ruta>    Carpeta de perfiles, secretos y auditoría.
  -w, --web-dir <ruta>     Carpeta con el renderer compilado (out/web).
  -t, --token <token>      Token de acceso (mínimo ${MIN_TOKEN_LENGTH} caracteres).
                           Si se omite, se genera uno persistente en <data-dir>/server-token.
                           Prefiere SSH_SFTP_TOKEN: --token queda en el historial del shell.
      --tls-cert <ruta>    Certificado PEM para servir HTTPS.
      --tls-key <ruta>     Llave PEM del certificado.
      --trust-proxy        Confía en X-Forwarded-Proto (detrás de un proxy TLS).
      --no-open            No intenta abrir el navegador al arrancar.
      --open               Abre el navegador al arrancar (por defecto).
  -v, --version            Muestra la versión.
  -h, --help               Muestra esta ayuda.

Variables de entorno:
  SSH_SFTP_HOST, SSH_SFTP_PORT, SSH_SFTP_DATA_DIR, SSH_SFTP_WEB_DIR,
  SSH_SFTP_TOKEN, SSH_SFTP_TLS_CERT, SSH_SFTP_TLS_KEY, SSH_SFTP_TRUST_PROXY,
  SSH_SFTP_OPEN. También se acepta PORT si SSH_SFTP_PORT no está definido.

Ejemplos:
  npx ssh-sftp-manager --open
  npx ssh-sftp-manager --host 0.0.0.0 --port 7777
  SSH_SFTP_TOKEN='mi-token-largo-y-secreto' ssh-sftp-manager --host 0.0.0.0

Seguridad:
  El modo servidor puede leer archivos del host y abrir sesiones SSH con las
  credenciales guardadas. No lo expongas a Internet sin HTTPS y un token fuerte;
  para redes externas usa una VPN o un reverse proxy con TLS.
`
}
