import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startServer, type RunningServer } from '../src/server/index'
import { CliError, DEFAULT_PORT, parseArgs } from '../src/server/args'
import { createServerSecretCodec, loadOrCreateToken } from '../src/server/paths'
import { asString } from '../src/main/validate'

const TOKEN = 'test-token-0123456789abcdef'
let failures = 0

function assert(condition: boolean, message: string, extra?: unknown): void {
  if (condition) return
  failures++
  console.error('FAIL: ' + message)
  if (extra !== undefined) console.error('  ', JSON.stringify(extra))
}

interface RpcEnvelope {
  ok: boolean
  result?: unknown
  error?: { message?: string }
}

async function main(): Promise<void> {
  const defaults = parseArgs([], {})
  assert(defaults.host === '127.0.0.1' && defaults.port === DEFAULT_PORT, 'valores por defecto del CLI', defaults)
  const custom = parseArgs(['--host', '0.0.0.0', '--port=8888', '--no-open'], {})
  assert(custom.host === '0.0.0.0' && custom.port === 8888, 'CLI acepta host y puerto', custom)
  assert(custom.openBrowser === false, 'CLI acepta --no-open', custom)
  const envPort = parseArgs([], { SSH_SFTP_PORT: '9999' })
  assert(envPort.port === 9999, 'CLI lee SSH_SFTP_PORT', envPort)
  const invalidEnvPort = parseArgs([], { SSH_SFTP_PORT: '-1' })
  assert(invalidEnvPort.port === DEFAULT_PORT, 'CLI ignora un puerto de entorno inválido', invalidEnvPort)
  let shortTokenFailed = false
  try {
    parseArgs(['--token', 'corto'], {})
  } catch (err) {
    shortTokenFailed = err instanceof CliError
  }
  assert(shortTokenFailed, 'CLI rechaza tokens cortos')
  assert(asString('  hola  ', 'x') === 'hola', 'asString recorta por defecto')
  assert(
    asString('  hola\n', 'x', { allowEmpty: true, trim: false }) === '  hola\n',
    'asString conserva espacios y saltos con trim:false'
  )

  const sandbox = await mkdtemp(join(tmpdir(), 'ssh-sftp-web-test-'))
  const webDir = join(sandbox, 'web')
  const dataDir = join(sandbox, 'data')
  const alphaDir = join(sandbox, 'alpha')
  await mkdir(join(webDir, 'assets'), { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(alphaDir, { recursive: true })
  await writeFile(join(alphaDir, 'nota.txt'), 'hola')
  await writeFile(
    join(webDir, 'index.html'),
    '<!doctype html><html><head><title>Prueba</title></head><body><div id="root"></div><script type="module" src="/assets/app-test.js"></script></body></html>'
  )
  await writeFile(join(webDir, 'assets', 'app-test.js'), 'console.log("hola")')

  let running: RunningServer | null = null
  try {
    running = await startServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webDir,
      token: TOKEN,
      version: '9.9.9-test',
      log: () => {}
    })
    const base = running.urls[0]
    const port = running.port
    assert(Boolean(base), 'el servidor expone una URL', running.urls)

    const health = await fetch(base + '/api/health')
    const healthBody = (await health.json()) as { ok?: boolean; version?: string }
    assert(health.status === 200 && healthBody.ok === true, 'health responde ok', healthBody)
    assert(healthBody.version === '9.9.9-test', 'health informa la versión', healthBody)

    const session = await fetch(base + '/api/session')
    const sessionBody = (await session.json()) as { authenticated?: boolean; platform?: string }
    assert(sessionBody.authenticated === false, 'sesión no autenticada por defecto', sessionBody)
    assert(sessionBody.platform === 'web', 'sesión indica plataforma web', sessionBody)

    const loginPage = await fetch(base + '/', { headers: { accept: 'text/html' } })
    const loginHtml = await loginPage.text()
    assert(loginPage.status === 200, 'GET / sin sesión muestra el acceso', loginPage.status)
    assert(loginHtml.includes('action="/api/login"'), 'la página de acceso tiene el formulario')
    assert(!loginHtml.includes('<script'), 'la página de acceso no ejecuta scripts')

    const unauthenticatedJson = await fetch(base + '/', { headers: { accept: 'application/json' } })
    assert(unauthenticatedJson.status === 401, 'GET / sin HTML exige autenticación', unauthenticatedJson.status)

    const wrongLogin = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'token-incorrecto-123456' })
    })
    assert(wrongLogin.status === 401, 'login con token incorrecto falla', wrongLogin.status)

    const login = await fetch(base + '/api/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TOKEN }).toString()
    })
    const setCookie = login.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0]
    assert(login.status === 303, 'login correcto redirige', login.status)
    assert(login.headers.get('location') === '/', 'login redirige a la raíz', login.headers.get('location'))
    assert(cookie.startsWith('ssh_sftp_session='), 'login entrega cookie de sesión', setCookie)
    assert(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'), 'cookie endurecida', setCookie)

    const index = await fetch(base + '/', { headers: { cookie, accept: 'text/html' } })
    const indexHtml = await index.text()
    const csp = index.headers.get('content-security-policy') ?? ''
    assert(index.status === 200, 'index autenticado responde 200', index.status)
    assert(indexHtml.includes('app-test.js'), 'index autenticado sirve el renderer')
    assert(index.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options presente')
    assert(csp.includes("connect-src 'self' ws://127.0.0.1:" + port), 'CSP permite el WebSocket del host', csp)

    const asset = await fetch(base + '/assets/app-test.js', { headers: { cookie } })
    assert(asset.status === 200, 'asset autenticado responde 200', asset.status)
    assert((asset.headers.get('content-type') ?? '').includes('javascript'), 'asset tiene tipo JS')
    assert((asset.headers.get('cache-control') ?? '').includes('immutable'), 'assets con caché inmutable')

    const rpc = async (
      method: string,
      params: unknown[],
      authCookie: string | null = cookie
    ): Promise<{ status: number; body: RpcEnvelope }> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (authCookie) headers.cookie = authCookie
      const response = await fetch(base + '/api/rpc', {
        method: 'POST',
        headers,
        body: JSON.stringify({ method, params })
      })
      return { status: response.status, body: (await response.json()) as RpcEnvelope }
    }

    const noAuth = await rpc('servers:list', [], null)
    assert(noAuth.status === 401, 'RPC sin sesión devuelve 401', noAuth.status)

    const list = await rpc('servers:list', [])
    assert(list.status === 200 && list.body.ok, 'RPC servers:list funciona', list.body)
    assert(Array.isArray(list.body.result) && (list.body.result as unknown[]).length === 0, 'lista vacía', list.body)

    const bearerResponse = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ method: 'servers:list', params: [] })
    })
    assert(bearerResponse.status === 200, 'RPC acepta Bearer token', bearerResponse.status)

    const local = await rpc('local:list-dirs', [sandbox])
    const listing = local.body.result as {
      path?: string
      entries?: { name: string; isDirectory: boolean }[]
    }
    assert(local.body.ok && listing.path === sandbox, 'local:list-dirs devuelve la ruta', local.body)
    assert(
      Boolean(listing.entries?.some((entry) => entry.name === 'alpha' && entry.isDirectory)),
      'el explorador ve subdirectorios',
      listing
    )

    const fileListing = await rpc('local:list-dirs', [join(alphaDir, 'nota.txt')])
    const fileListingBody = fileListing.body.result as {
      path?: string
      entries?: { name: string; isDirectory: boolean }[]
    }
    assert(
      fileListing.body.ok && fileListingBody.path === alphaDir,
      'abrir una ruta de archivo lista su carpeta',
      fileListing.body
    )
    assert(
      Boolean(fileListingBody.entries?.some((entry) => entry.name === 'nota.txt' && !entry.isDirectory)),
      'la carpeta contiene el archivo',
      fileListingBody
    )

    const saves = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        rpc('servers:save', [
          {
            name: 'Concurrente ' + index,
            host: '10.0.0.' + (100 + index),
            port: 22,
            username: 'deploy',
            authMethod: 'agent',
            privateKeyPath: null,
            remoteRoot: null,
            localRoot: null,
            jumpHost: null
          }
        ])
      )
    )
    assert(
      saves.every((saved) => saved.body.ok),
      'guardados concurrentes no fallan',
      saves.map((saved) => saved.body)
    )
    const afterSaves = await rpc('servers:list', [])
    assert(
      Array.isArray(afterSaves.body.result) && (afterSaves.body.result as unknown[]).length === 8,
      'ningún guardado concurrente se pierde',
      afterSaves.body
    )

    const updates = await rpc('updates:state', [])
    const updateState = updates.body.result as { status?: string; message?: string }
    assert(updates.body.ok && updateState.status === 'unsupported', 'updates:state es unsupported', updates.body)

    const unknown = await rpc('no:existe', [])
    assert(unknown.body.ok === false, 'método desconocido devuelve error RPC', unknown.body)

    const traversal = await fetch(base + '/%2e%2e%2fpackage.json', { headers: { cookie } })
    assert(traversal.status === 404, 'bloquea path traversal', traversal.status)

    const wsGet = await fetch(base + '/api/ws', { headers: { cookie } })
    assert(wsGet.status === 426, 'GET /api/ws pide actualizar a WebSocket', wsGet.status)

    const evilOrigin = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://evil.example'
      },
      body: JSON.stringify({ method: 'servers:list', params: [] })
    })
    assert(evilOrigin.status === 403, 'rechaza POST con Origin ajeno', evilOrigin.status)

    const logout = await fetch(base + '/api/logout', { method: 'POST', headers: { cookie } })
    const logoutCookie = logout.headers.get('set-cookie') ?? ''
    assert(logout.status === 200, 'logout responde ok', logout.status)
    assert(logoutCookie.includes('Max-Age=0'), 'logout borra la cookie', logoutCookie)

    const tokenLink = await fetch(base + '/?token=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
    assert(tokenLink.status === 303, 'enlace con token inicia sesión', tokenLink.status)
    assert(tokenLink.headers.get('location') === '/', 'enlace con token limpia la URL', tokenLink.headers.get('location'))
    assert(Boolean(tokenLink.headers.get('set-cookie')), 'enlace con token entrega cookie')

    const badTokenLink = await fetch(base + '/?token=token-invalido-1234567', {
      headers: { accept: 'text/html' }
    })
    assert(badTokenLink.status === 401, 'enlace con token inválido se rechaza', badTokenLink.status)

    const redirectLogin = await fetch(base + '/login', { headers: { cookie }, redirect: 'manual' })
    assert(redirectLogin.status === 303, 'login autenticado redirige', redirectLogin.status)

    const wsUrl = 'ws://127.0.0.1:' + port + '/api/ws'
    const socket = new WebSocket(wsUrl, { headers: { cookie } })
    try {
      const received: Record<string, unknown>[] = []
      const waiters: ((message: Record<string, unknown>) => void)[] = []
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        const waiter = waiters.shift()
        if (waiter) waiter(message)
        else received.push(message)
      })
      const nextMessage = (): Promise<Record<string, unknown>> => {
        const queued = received.shift()
        if (queued) return Promise.resolve(queued)
        return new Promise((resolve) => waiters.push(resolve))
      }
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })
      const hello = await nextMessage()
      assert(hello.type === 'hello', 'WebSocket saluda al conectar', hello)
      socket.send(JSON.stringify({ type: 'rpc', id: 7, method: 'servers:list', params: [] }))
      let reply = await nextMessage()
      while (reply.type !== 'rpc-result') reply = await nextMessage()
      assert(reply.id === 7 && reply.ok === true, 'RPC por WebSocket responde', reply)
    } finally {
      socket.close()
    }

    const codecDir = join(sandbox, 'codec')
    const codec = createServerSecretCodec(codecDir)
    const encrypted = codec.encrypt('secreto-de-prueba')
    assert(codec.decrypt(encrypted) === 'secreto-de-prueba', 'el codec descifra lo suyo')
    const parts = encrypted.split(':')
    const ciphertext = Buffer.from(parts[3], 'base64url')
    ciphertext[0] ^= 0xff
    const tampered = [parts[0], parts[1], parts[2], ciphertext.toString('base64url')].join(':')
    assert(codec.decrypt(tampered) === null, 'el codec detecta manipulación')
    const reopened = createServerSecretCodec(codecDir)
    assert(reopened.decrypt(encrypted) === 'secreto-de-prueba', 'la llave persiste entre arranques')
    if (process.platform !== 'win32') {
      const keyMode = (await stat(join(codecDir, 'secret.key'))).mode & 0o777
      assert(keyMode === 0o600, 'secret.key tiene permisos 0600', keyMode.toString(8))
    }

    const tokenDir = join(sandbox, 'tokens')
    const firstToken = loadOrCreateToken(tokenDir)
    const secondToken = loadOrCreateToken(tokenDir)
    assert(firstToken === secondToken, 'el token persistente se reutiliza')
    assert(firstToken.length >= 32, 'el token generado es largo', firstToken.length)
    if (process.platform !== 'win32') {
      const tokenMode = (await stat(join(tokenDir, 'server-token'))).mode & 0o777
      assert(tokenMode === 0o600, 'server-token tiene permisos 0600', tokenMode.toString(8))
    }
  } finally {
    if (running) await running.close()
    await rm(sandbox, { recursive: true, force: true })
  }

  if (failures === 0) console.log('OK: todas las pruebas del servidor web pasaron')
  else {
    console.error(failures + ' fallo(s)')
    process.exitCode = 1
  }
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
