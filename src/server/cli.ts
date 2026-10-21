import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CliError, helpText, parseArgs } from './args'
import { openUrl } from './open'
import { tokenFilePath } from './paths'
import { startServer } from './index'

declare const __dirname: string

function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
  } catch {
    /* instalación empaquetada sin package.json accesible */
  }
  return process.env.npm_package_version ?? '0.0.0'
}

function readTlsFile(file: string, label: string): Buffer {
  try {
    return readFileSync(file)
  } catch {
    throw new CliError('No se pudo leer ' + label + ': ' + file)
  }
}

async function main(): Promise<void> {
  const version = currentVersion()
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof CliError) {
      console.error('Error: ' + err.message)
      console.error('Usa --help para ver las opciones.')
      process.exitCode = 1
      return
    }
    throw err
  }

  if (options.help) {
    console.log(helpText(version))
    return
  }
  if (options.versionRequested) {
    console.log(version)
    return
  }

  const tls =
    options.tlsCert && options.tlsKey
      ? {
          cert: readTlsFile(options.tlsCert, 'el certificado'),
          key: readTlsFile(options.tlsKey, 'la llave')
        }
      : null

  let running
  try {
    running = await startServer({
      host: options.host,
      port: options.port,
      dataDir: options.dataDir,
      webDir: options.webDir,
      token: options.token ?? undefined,
      version,
      tls,
      trustProxy: options.trustProxy,
      log: (message) => console.error(message)
    })
  } catch (err) {
    console.error('No se pudo iniciar el servidor: ' + (err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
    return
  }

  const protocol = tls ? 'HTTPS' : 'HTTP'
  console.log('')
  console.log('  SSH · SFTP Manager v' + running.version + ' — modo servidor web (' + protocol + ')')
  console.log('  Datos:  ' + options.dataDir)
  console.log(
    '  Token:  ' +
      (options.token
        ? 'definido por --token o SSH_SFTP_TOKEN'
        : tokenFilePath(options.dataDir))
  )
  console.log('')
  for (const url of running.accessUrls) {
    console.log('  ➜  ' + url)
  }
  if (running.host === '0.0.0.0' || running.host === '::') {
    console.log('')
    console.log('  Accesible desde otros dispositivos de la red con esas URL.')
    console.log('  Si no responde, revisa el firewall del equipo para el puerto ' + running.port + '.')
  }
  if (!tls) {
    console.log('')
    console.log('  Aviso: HTTP sin cifrar. Para Internet usa --tls-cert/--tls-key o un reverse proxy TLS.')
  }
  console.log('')
  console.log('  Ctrl+C para detener.')
  console.log('')

  if (options.openBrowser && process.stdout.isTTY && !process.env.CI) {
    const target = running.accessUrls[0]
    if (target) openUrl(target)
  }

  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    console.log('')
    console.log('Deteniendo SSH · SFTP Manager…')
    void running
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('Error al cerrar: ' + String(err))
        process.exit(1)
      })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

void main().catch((err: unknown) => {
  console.error('Error inesperado: ' + (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
})
