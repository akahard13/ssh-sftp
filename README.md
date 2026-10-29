# DeploySync

App para administrar **múltiples sesiones SSH** contra servidores privados, con terminal interactiva y un
comparador de directorios que permite **subir solo los cambios seleccionados** por SFTP.

Se puede usar de dos formas con el mismo código:

| Modo | Dónde corre | Cómo se abre |
| --- | --- | --- |
| **Escritorio** | Windows (instalador NSIS) o Linux (AppImage/deb) | Ventana nativa de Electron |
| **Servidor web** | Linux, macOS, Windows o un contenedor | Navegador en `http://IP-DEL-EQUIPO:PUERTO` |

En ambos modos la sesión SSH y las operaciones SFTP ocurren en el equipo donde corre la app; el navegador
solo dibuja la interfaz. Así puedes instalarlo en un servidor Linux y usarlo desde el portátil, la tablet
o cualquier equipo de la red.

No abre varias ventanas: mantiene una sesión (y sus canales) por servidor y tú eliges cuál usar.

## Requisitos

- **Node.js 20 o superior** (probado con 22 y 24) para el modo servidor y para compilar.
- **Windows** en el equipo cliente si usas el instalador de escritorio (la ventana usa
  `safeStorage`/DPAPI para cifrar secretos).
- Acceso de red a los servidores (VPN o bastión si aplica).
- En Linux/macOS, si usas autenticación por `ssh-agent`, el servicio necesita `SSH_AUTH_SOCK`.

## Instalación

### Windows: instalador de escritorio

Descarga `DeploySync-<versión>-setup.exe` desde
[GitHub Releases](https://github.com/akahard13/ssh-sftp/releases) y ejecútalo. El instalador es
`perMachine: false`: se instala en `%LOCALAPPDATA%` sin pedir administrador y se actualiza solo
(ver [Actualizaciones](#actualizaciones)).

#### Instalación silenciosa (sin ventanas)

El `.exe` es un instalador NSIS, así que acepta sus parámetros estándar:

```powershell
# instala sin abrir ninguna ventana (per-usuario, bajo %LOCALAPPDATA%)
.\DeploySync-0.2.9-setup.exe /S

# ruta de instalación propia: /D va al final y sin comillas
.\DeploySync-0.2.9-setup.exe /S /D=C:\Apps\DeploySync
```

Como es `perMachine: false`, no pide permisos de administrador. Para desplegarlo en varios equipos:

```powershell
Invoke-Command -ComputerName PC1,PC2 -ScriptBlock {
  Start-Process '\\srv\deploy\DeploySync-0.2.9-setup.exe' -ArgumentList '/S' -Wait
}
```

Las actualizaciones automáticas ya se instalan en silencio: el actualizador ejecuta el instalador con `/S`.

> **Si vienes de la versión anterior ("SSH SFTP Manager")**, la primera vez que abras DeploySync se
> copian los perfiles, secretos, `known_hosts`, auditoría y ajustes desde
> `%APPDATA%\ssh-sftp-manager\data` a `%APPDATA%\deploysync\data`, junto con la llave de cifrado de
> `<userData>/Local State`, así que las contraseñas guardadas siguen funcionando. Después puedes
> desinstalar la app antigua. La versión web también cambia de directorio: usa `--data-dir` si quieres
> conservar el anterior.

### Servidor web con `npx` (recomendado para Linux/macOS)

```bash
npx deploysync --host 0.0.0.0 --port 7777
```

La primera vez genera un token, imprime una URL como
`http://192.168.1.20:7777/?token=...` y abre el navegador. Abre esa misma URL desde cualquier
dispositivo de la red.

> `npx` descarga el paquete desde npm. Si todavía no está publicado, usa la
> [instalación desde el código](#desde-el-código-desarrollo).

### Servidor web con `npm` global

```bash
npm install -g deploysync
deploysync --host 0.0.0.0 --port 7777
```

### Servidor web con `curl`

```bash
curl -fsSL https://raw.githubusercontent.com/akahard13/ssh-sftp/main/scripts/install.sh | bash
```

El instalador comprueba Node/npm, instala el paquete globalmente y, si no hay permisos, cae a
`~/.local`. Para instalarlo y arrancarlo en un solo paso:

```bash
curl -fsSL https://raw.githubusercontent.com/akahard13/ssh-sftp/main/scripts/install.sh | bash -s -- --start
```

Opciones del instalador: `--prefix <ruta>`, `--port <puerto>`, `--start`, `--no-open`, `--help`.
También acepta `DEPLOYSYNC_VERSION`, `DEPLOYSYNC_PREFIX`, `DEPLOYSYNC_HOST` y `DEPLOYSYNC_PORT`.

### Linux: paquete de escritorio

```bash
npm install
npm run build
npm run package:linux    # genera AppImage y .deb en dist/
```

También puedes usar el modo servidor web en Linux sin instalar Electron. Para servidores headless es
la opción recomendada. El escritorio Linux cifra los secretos con **libsecret**; si el sistema no lo
tiene, la app avisará y no podrá guardar contraseñas (los perfiles sin secreto, como `ssh-agent`, sí
funcionan). El auto-update de escritorio está limitado a Windows.

### Desde el código (desarrollo)

```bash
npm install
npm run dev        # escritorio Electron con recarga en caliente
npm run serve      # compila out/web + out/server y arranca el servidor web
```

Si `npm install` no descarga el binario de Electron (proxy/red restringida):

```bash
node node_modules/electron/install.js
```

Para probar el paquete npm antes de publicarlo:

```bash
npm run build:web
npm pack             # revisa el .tgz
npm install -g ./deploysync-0.2.2.tgz
```

## Comandos

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Compila main/preload y lanza Electron con Vite en modo desarrollo |
| `npm run build` | Compila `out/main`, `out/preload` y `out/renderer` (escritorio) |
| `npm run build:web` | Compila el renderer web en `out/web` y el CLI en `out/server` |
| `npm run server` | Arranca el servidor web usando los artefactos ya compilados |
| `npm run serve` | `build:web` + `server` (para probar en local) |
| `npm run typecheck` | Verifica tipos de los proyectos Node y Web |
| `npm test` | Pruebas de diff/merge, recorrido de directorios y servidor web |
| `npm run test:server` | Solo las pruebas de integración HTTP/WebSocket |
| `npm run package` | Genera el **instalador NSIS** en `dist/` (necesario para auto-update) |
| `npm run package:dir` | Genera solo la carpeta portable `dist/win-unpacked` |
| `npm run package:linux` | Genera AppImage y `.deb` en `dist/` |
| `npm run release` | Igual que `package` y además publica el release en GitHub (requiere `GH_TOKEN`) |

## Modo servidor web

### Arranque y acceso

```bash
# Solo este equipo (por defecto)
npx deploysync

# Toda la red local
npx deploysync --host 0.0.0.0 --port 7777

# HTTPS directo
npx deploysync --host 0.0.0.0 --port 7777 \
  --tls-cert /etc/ssl/certs/deploysync.crt \
  --tls-key /etc/ssl/private/deploysync.key
```

Al arrancar imprime una URL por cada interfaz disponible, cada una con su `?token=`. Al abrirla, el
token se canjea por una cookie `HttpOnly` y desaparece de la barra de direcciones. La interfaz se adapta
a pantallas pequeñas (tablet y móvil): la barra lateral pasa arriba y el comparador a una columna.

- Por defecto escucha solo en `127.0.0.1`: úsalo desde la misma máquina.
- Con `--host 0.0.0.0` acepta conexiones de la LAN. Habilita el puerto en el firewall
  (`ufw allow 7777/tcp`, grupo de seguridad de la nube, etc.).
- Si no abre el navegador o no hay entorno gráfico, usa la URL impresa.
- `--no-open` evita el intento de abrir el navegador (útil en systemd o CI).

### Opciones y variables de entorno

| Opción | Variable | Valor por defecto | Descripción |
| --- | --- | --- | --- |
| `--host, -H` | `DEPLOYSYNC_HOST` | `127.0.0.1` | Interfaz de escucha. `0.0.0.0` para la LAN. |
| `--port, -p` | `DEPLOYSYNC_PORT` o `PORT` | `7777` | Puerto HTTP/HTTPS. `0` elige uno libre. |
| `--data-dir, -d` | `DEPLOYSYNC_DATA_DIR` | ver [Datos](#dónde-se-guardan-los-datos) | Perfiles, secretos, known_hosts y auditoría. |
| `--web-dir, -w` | `DEPLOYSYNC_WEB_DIR` | `out/web` junto al CLI | Renderer compilado que se sirve. |
| `--token, -t` | `DEPLOYSYNC_TOKEN` | token persistente | Token de acceso (mínimo 16 caracteres). |
| `--tls-cert` | `DEPLOYSYNC_TLS_CERT` | — | Certificado PEM para HTTPS. |
| `--tls-key` | `DEPLOYSYNC_TLS_KEY` | — | Llave privada PEM. |
| `--trust-proxy` | `DEPLOYSYNC_TRUST_PROXY` | `false` | Confía en `X-Forwarded-Proto` para marcar la cookie `Secure`. |
| `--open / --no-open` | `DEPLOYSYNC_OPEN` | abierto | Abre el navegador al arrancar. |
| `--help, -h` | — | — | Ayuda. |
| `--version, -v` | — | — | Versión. |

Las variables `DEPLOYSYNC_MASTER_KEY` (32 bytes en base64 o hex) permiten usar una llave de cifrado
externa; si no se define, se crea `<data-dir>/secret.key` con permisos `0600`.

### Token y rotación

El token se guarda en `<data-dir>/server-token` con permisos `0600` para que las sesiones sobrevivan a
reinicios. Para rotarlo:

1. Detén el servidor.
2. Borra `<data-dir>/server-token` (o define un `DEPLOYSYNC_TOKEN` nuevo y largo).
3. Arranca de nuevo y usa la URL con el token nuevo.

El token es una **credencial administrativa**: permite abrir SSH, leer archivos del host y escribir en
los servidores. No lo compartas por canales inseguros. Si usas `--token`, queda en el historial del
shell y en la lista de procesos; prefiere la variable `DEPLOYSYNC_TOKEN`.

### Dónde se guardan los datos

| Sistema | Carpeta por defecto |
| --- | --- |
| Linux | `~/.config/deploysync` (o `$XDG_CONFIG_HOME`) |
| macOS | `~/Library/Application Support/deploysync` |
| Windows | `%APPDATA%\deploysync` |

Contenido: `profiles.json`, `secrets.json`, `known_hosts.json`, `settings.json`, `audit.json`,
`server-token` y `secret.key`. El escritorio Electron usa su propio directorio de usuario; el modo
servidor no lee esa carpeta salvo que le pases `--data-dir`.

Los secretos del modo servidor se cifran con **AES-256-GCM**. Protege `secrets.json` frente a copias
sueltas, pero la llave vive en el mismo directorio: quien pueda leer toda la carpeta (o ejecutar como el
mismo usuario) puede descifrarlos. Restringe permisos del directorio y de la cuenta del servicio. Si
pierdes `secret.key` (y no usas `DEPLOYSYNC_MASTER_KEY`), deberás volver a escribir las contraseñas y
passphrases de los perfiles.

### systemd (Linux)

```ini
[Unit]
Description=DeploySync (servidor web)
After=network.target

[Service]
Type=simple
User=deploy
Environment=DEPLOYSYNC_HOST=0.0.0.0
Environment=DEPLOYSYNC_PORT=7777
Environment=DEPLOYSYNC_DATA_DIR=/var/lib/deploysync
# Si usas ssh-agent:
# Environment=SSH_AUTH_SOCK=/run/user/1000/ssh-agent.socket
ExecStart=/usr/local/bin/deploysync --no-open
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/deploysync
sudo chown deploy:deploy /var/lib/deploysync
sudo systemctl daemon-reload
sudo systemctl enable --now deploysync
sudo journalctl -u deploysync -f   # muestra la URL con el token
```

### Reverse proxy con TLS

Si prefieres terminar TLS en nginx/Caddy y dejar el servicio en `127.0.0.1`, el proxy **debe conservar
el `Host`** y reenviar `Upgrade` para el WebSocket:

```nginx
server {
    listen 443 ssl http2;
    server_name ssh.ejemplo.com;

    ssl_certificate     /etc/ssl/certs/deploysync.crt;
    ssl_certificate_key /etc/ssl/private/deploysync.key;

    # Las subidas viajan por HTTP: deja margen sobre el límite de la app (32 MB).
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

Arranca el servicio con `--trust-proxy` para que la cookie se marque `Secure`. La CSP y la validación
de `Origin` usan el `Host` de la petición: si el proxy no lo conserva, el navegador rechazará el
WebSocket.

### Varios dispositivos

Varias pestañas o dispositivos pueden abrir la misma instancia. Comparten las mismas sesiones SSH,
terminales y tokens de acceso; la app está pensada para un operador. Si dos personas escriben en la
misma terminal, verán y enviarán las mismas pulsaciones.

## Flujo de uso

1. **Agregar servidor**: nombre, host, puerto, usuario y método de autenticación (llave privada,
   `ssh-agent` o contraseña). Opcionalmente un directorio remoto base, uno local y un bastión.
2. **Conectar**: al primer contacto la app muestra la huella del host; hay que verificarla y confiar en
   ella antes de que se guarde en `known_hosts`.
3. **Terminal**: pestaña `Terminal`, sesión completa sobre `xterm-256color` con redimensionado real.
4. **Comparar / Subir**: elige el directorio local y el del servidor, pulsa `Comparar` y verás un
   **árbol plegable** con el estado de cada archivo (`solo local`, `solo servidor`, `distinto`, `igual`,
   `mismo tamaño`). Cada carpeta muestra cuántas diferencias tiene debajo, así que sabes dónde mirar sin
   desplegar todo; `Expandir` y `Cerrar` abren o pliegan el árbol completo.
   Arrastra el divisor (o usa `←`/`→` con `Shift` para pasos grandes) para **ensanchar o encoger** la
   lista; el botón `«` de la cabecera la **oculta** y el riel `»` de la izquierda la vuelve a mostrar.
   Con el botón **Exclusiones** ajustas qué se ignora antes de comparar: acepta nombres de carpeta o de
   archivo y comodines `*` (`node_modules`, `*.log`, `config/local.php`). Lo que escribas queda guardado.
   En el modo web, el botón **Explorar…** abre un navegador de carpetas **del equipo que ejecuta el
   servicio**, porque los diálogos nativos no existen en el navegador.
5. **Revisar un archivo**: se abre el diff a dos columnas (servidor ↔ local) con un bloque seleccionable
   por cada cambio, más un tercer panel con el **archivo generado**. Los tres paneles tienen scroll
   propio (vertical y horizontal) y dos divisores arrastrables, también ajustables con las flechas del
   teclado, para repartir el ancho a gusto.
   Si el archivo aparece como `solo servidor`, al abrirlo ves su contenido y el botón **Descargar** lo
   copia a tu directorio local respetando la ruta relativa (crea las carpetas que falten y nunca
   sobrescribe un archivo existente). Los binarios y los archivos grandes no se previsualizan, pero se
   pueden descargar igual (hasta 64 MB).
6. **Subir**: `Subir seleccionados` escribe en el servidor solo los bloques marcados, de forma atómica y
   con respaldo opcional (desmarcado por defecto). Si el archivo es nuevo y su carpeta tampoco existe en
   el servidor, se crea la carpeta (y sus padres) antes de escribir.
   Con el botón `↑` de cualquier carpeta del árbol subes **de una vez todos los archivos locales** de esa
   carpeta y sus subcarpetas, tal como están en disco (sin merge por bloques): los que ya coinciden con el
   servidor se omiten y el resto se escribe en paralelo, con progreso y un resumen de errores. La vista del
   archivo que tengas abierto no cambia si mientras tanto te moviste a otro.
7. **Subir por rutas**: el botón **Subir por rutas…** abre un cuadro donde pegas **una ruta por línea**
   (relativas al directorio local o absolutas del equipo; si es una carpeta se expande completa). La lista
   de carpetas pasa entonces a mostrar **solo esos archivos**, con una casilla por archivo y por carpeta,
   y las acciones `Todos`, `Ninguno`, `Subir seleccionados` y `Salir` (esta última vuelve a la
   comparación). Antes de escribir nada, un diálogo de confirmación vuelve a mostrar la lista exacta de
   archivos y el destino.
   En esta tanda el respaldo **no** se deja junto al archivo: la versión anterior del servidor se mueve a
   `backup_files/<fecha>/` **dentro del proyecto remoto** (se crea la carpeta y sus subcarpetas si no
   existen), conservando la ruta relativa de cada archivo. El respaldo `.bak-<fecha>` junto al archivo se
   mantiene solo para la subida individual de un archivo con la casilla **Respaldo** marcada.


## Actualizaciones

### Escritorio (Windows)

La app usa `electron-updater` contra **GitHub Releases**. Antes de la primera publicación hay que
rellenar en [package.json](./package.json) (`build.publish`) el `owner` y el `repo` reales; hasta
entonces la app muestra "Actualizaciones no configuradas" y no intenta descargar nada.

#### Requisitos

- La app debe estar **instalada con el instalador NSIS** (`npm run package`). La carpeta portable de
  `--dir` no se puede auto-actualizar.
- El instalador se configura como `perMachine: false`: se instala en `%LOCALAPPDATA%` y **no pide
  administrador**, así que las actualizaciones también se aplican sin UAC.
- El repo de releases es privado, y `electron-updater` necesita un token en **cada equipo**:

  ```powershell
  setx GH_TOKEN "github_pat_..."   # token fine-grained, permiso solo de lectura de Contents
  ```

  Cerrar y reabrir la app para que tome la variable. Un token sin ese permiso produce el aviso
  "El repositorio de releases es privado y falta la credencial".

#### Cómo publicar una versión

**Todo sale de `version` en `package.json`**: el nombre de los assets
(`DeploySync-<version>-setup.exe`), el campo `version` de `latest.yml` **y el tag del release**,
que electron-builder calcula como `v` + esa versión. Los tags de git **no influyen**: si creas `v0.1.5`
pero `package.json` sigue en `0.1.4`, se publica el release `v0.1.4` y tu tag queda huérfano.

```powershell

# 1. Sube la versión en package.json ("version": "0.2.2")
# 2. Crea y sube el tag ANTES de publicar (ver nota abajo)
git tag v0.2.2
git push origin v0.2.2
# 3. Compila y publica
$env:GH_TOKEN = "github_pat_..."
npm run release
```

> **El tag debe coincidir con la versión** (`v<version>`). Puedes crearlo y subirlo antes
> (`git tag v0.1.5 && git push origin v0.1.5`): eso evitaba el error `422 Published releases must have a
> valid tag` que aparecía antes del parche de `app-builder-lib`. Pero si el tag no coincide con
> `package.json`, la publicación va al tag derivado de la versión y los dos quedan desincronizados.
>
> Si un release queda incompleto, **vuelve a ejecutar `npm run release`**: al detectar el release
> existente (publicado hace menos de 2 horas) vuelve a subir los archivos y sobreescribe los que ya
> estaban. Verifica siempre que el release tenga **3 assets**: el `.exe`, el `.blockmap` y `latest.yml`.
> Sin `latest.yml` la app no puede actualizarse.
>
> **Parche local obligatorio (`patches/`).** `app-builder-lib@26.15.3` tiene un bug abierto
> ([electron-builder#10026](https://github.com/electron-userland/electron-builder/issues/10026)): los
> artefactos se publican en paralelo y la caché del publisher no se rellena hasta después del `await`,
> así que cada artefacto crea **su propio release del mismo tag** y reparte los assets (el `.exe` en un
> release y `latest.yml` + `.blockmap` en otro). Eso rompe el auto-update: la URL por tag
> `.../releases/download/vX/latest.yml` responde 404. `npm install` aplica
> `patches/app-builder-lib+26.15.3.patch` mediante el script `postinstall` (`patch-package`); **no
> elimines ese `postinstall`**. El fix oficial está en la rama 27.x (todavía en alpha), así que al
> actualizar `electron-builder` revisa si ya lo incluye y, en ese caso, borra el parche.

Esto sube el `.exe` del instalador, el `latest.yml` y el `.blockmap` al release de GitHub. El
`.blockmap` es lo que permite descargas diferenciales: solo se bajan los bloques que cambiaron.

> El nombre del archivo local ya está fijado como `DeploySync-<versión>-setup.exe`, que es
> exactamente el que espera `latest.yml`. Si publicas el release **a mano** en vez de con
> `npm run release`, sube el archivo sin renombrarlo: cualquier cambio de nombre hace que la app reciba
> un 404 al buscar la actualización.

#### Cómo se comporta la app

- Verifica al arrancar (15 s después) y luego cada 6 horas; también hay un botón manual "Buscar
  actualizaciones" en el panel inferior de la barra lateral.
- Descarga **solo si el usuario lo pide** (`autoDownload = false`) y muestra el progreso.
- Al terminar avisa "reiniciar e instalar"; si no, aplica la actualización al cerrar la app
  (`autoInstallOnAppQuit = true`).

### Servidor web (npm)

El modo servidor **no se autoactualiza**; el panel muestra un aviso y el botón queda deshabilitado.
Actualiza desde la terminal y reinicia el servicio:

```bash
npm install -g deploysync@latest
sudo systemctl restart deploysync
```

Los perfiles y secretos quedan en `<data-dir>` y sobreviven a la actualización.

## Publicar el paquete en npm

`prepublishOnly` ejecuta `typecheck`, toda la suite y `build:web` antes de empaquetar. El paquete
incluye `out/server`, `out/web`, `scripts/install.sh` y este README; no incluye Electron.

```bash
npm login
npm version 0.2.2 --no-git-tag-version
npm publish
```

Comprueba el contenido antes con `npm pack --dry-run`. El nombre `deploysync` debe estar
disponible en el registro.

## Modelo de seguridad

- **Verificación de host key obligatoria** (TOFU con `known_hosts` propio). Si la huella cambia, la
  conexión se bloquea y se avisa; nunca se acepta automáticamente.
- **Secretos cifrados**:
  - Escritorio: `safeStorage` (DPAPI en Windows, Keychain en macOS, libsecret en Linux), en un archivo
    aparte con permisos `0600`.
  - Servidor: AES-256-GCM con una llave `0600` en el directorio de datos (o `DEPLOYSYNC_MASTER_KEY`).
  Las contraseñas y passphrases nunca llegan al renderer ni se escriben en logs.
- **Autenticación web por token**: cookie de sesión `HttpOnly`, `SameSite=Strict` y `Secure` bajo TLS.
  La cookie guarda un HMAC del token, no el token. Los POST y el WebSocket validan `Origin`; el login
  tiene límite de intentos por IP.
- **Superficie mínima**: el servidor solo sirve `out/web` y una API RPC con métodos conocidos; rechaza
  `..` en rutas estáticas y exige sesión incluso para los assets.
- **Proceso de renderizado aislado** (escritorio): `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, sin `webview`, CSP estricta en producción y navegación bloqueada.
- **Superficie IPC/RPC mínima y validada**: cada mensaje se comprueba campo por campo antes de usarse.
- **Sin inyección de comandos**: se usan las APIs de SFTP, no se construyen cadenas de shell.
- **Rutas acotadas**: toda operación remota se valida contra el directorio base del servidor
  (`assertInsideRoot`) para impedir salir de él.
- **Escritura atómica**: se escribe en un archivo temporal del mismo directorio, se sincroniza, se
  conservan permisos y se renombra sobre el original. Si se activa el respaldo, el original se conserva
  como `<archivo>.bak-<fecha>`.
- **Concurrencia optimista**: antes de subir se re-compara el hash del archivo remoto; si cambió desde la
  comparación, la subida se rechaza.
- **Auditoría local**: conexiones, desconexiones, huellas aceptadas y subidas quedan registradas en
  `audit.json` (últimos 2000 eventos), visible en el log local de la app.

### Advertencia sobre el modo servidor

El modo servidor convierte la app en un panel de administración remoto. Cualquiera que tenga el token y
acceso de red puede **abrir sesiones SSH, leer y escribir archivos del host donde corre el servicio y
subir cambios a tus servidores**. Por eso:

- Escucha en `127.0.0.1` por defecto. Expón `0.0.0.0` solo en una LAN de confianza o detrás de VPN.
- No lo publiques directamente en Internet por HTTP. Usa `--tls-cert`/`--tls-key` o un reverse proxy
  TLS, un token largo y un firewall.
- Trata `<data-dir>` como material sensible: contiene la llave de los secretos y el token.
- Rota el token si se filtra y revisa los intentos fallidos en el journal del servicio.

## Estructura

```
src/
  main/            host de escritorio Electron + núcleo compartido
    index.ts       ventana, ciclo de vida y endurecimiento
    ipc.ts         adaptador IPC de Electron (diálogos nativos incluidos)
    services.ts    dispatcher único de operaciones (IPC y HTTP/WebSocket)
    secret.ts      codec de secretos del escritorio (safeStorage)
    updater.ts     auto-actualización de escritorio (electron-updater)
    store.ts       perfiles, secretos cifrados, known_hosts y auditoría
    validate.ts    validadores de entrada
    ssh/
      manager.ts   pool de sesiones, canales, host key y 2FA
      sftp.ts      operaciones SFTP, walk recursivo y escritura atómica
      compare.ts   comparación de directorios y lectura de pares de archivos
  server/          modo servidor web headless
    cli.ts         binario npm (deploysync)
    args.ts        opciones y variables de entorno
    index.ts       HTTP, WebSocket, sesiones, estáticos y RPC
    auth.ts        token, cookie HMAC, Origin y rate limit
    paths.ts       token persistente y cifrado AES-256-GCM
    open.ts        apertura del navegador
src/preload/       puente seguro (contextBridge) hacia el renderer
src/renderer/      interfaz React compartida
  src/lib/         motor de diff, merge y cliente WebSocket del modo servidor
  src/components   Sidebar, Terminal, Comparar, Diff, explorador de rutas y actualizaciones
src/shared/        tipos y contrato de la API
tools/             pruebas de diff, recorrido, árbol y servidor
scripts/install.sh instalador de curl
vite.web.config.ts build del renderer para el servidor
.github/workflows/ci.yml  tipos, pruebas y builds en cada PR
```

## Decisiones de diseño

- **Un solo núcleo, dos transportes**: toda la lógica sensible vive en `src/main/services.ts` y no
  importa Electron. El escritorio la expone por IPC y el servidor por HTTP/WebSocket.
- **Un solo paquete npm**: el binario arranca un servidor que sirve el mismo renderer React compilado.
  No hay dos interfaces que mantener.
- **Sin editor embebido**: el diff se dibuja a medida (dos columnas alineadas, resaltado y selección por
  bloque) en lugar de arrastrar Monaco/CodeMirror. Menos memoria y arranque más rápido.
- **Sin SQLite nativo**: los metadatos van en JSON atómico; solo los secretos se cifran. Evita módulos
  nativos que requieren recompilarse contra Electron.
- **Sin escrituras parciales in-place**: para subir "solo los cambios" se reconstruye el contenido final
  y se reemplaza el archivo de forma atómica. Es más seguro que parchear rangos.
- **El escaneo no descarga archivos**: la comparación de directorios usa tamaño y fecha de modificación,
  y solo se lee el contenido cuando abres un archivo. Antes descargaba cada archivo de igual tamaño para
  calcular su hash, lo que hacía inviable un proyecto con miles de archivos.
- **Recorrido en paralelo**: el listado de carpetas con concurrencia limitada (12 a la vez) en lugar de
  una petición por carpeta en serie, que dominaba el tiempo total.
- **Exclusiones configurables**: `node_modules`, `vendor`, `.git`, `storage`, `dist`, `build` y similares
  se omiten por defecto en ambos lados. La lista es editable desde la interfaz y acepta **archivos además
  de carpetas**, con `*` y `?` como comodines; un patrón sin `/` compara contra el nombre y con `/` contra
  la ruta relativa. El número de carpetas y archivos ignorados se muestra en la lista.
- **SFTP no notifica cambios**: el árbol se refresca al comparar o al subir; no hay vigilancia remota.
- **WebSocket para el navegador**: el RPC y los eventos (terminal, progreso, prompts de host key y 2FA)
  viajan por una sola conexión bidireccional; la terminal no sufre la latencia de un POST por tecla.

## Límites conocidos

- `build.publish` en [package.json](./package.json) tiene `owner`/`repo` de ejemplo: hay que
  rellenarlos con el repositorio real antes de publicar releases.
- No hay firma de código, así que SmartScreen avisará como editor desconocido.
- El diff solo aplica a archivos de texto y de hasta 4 MB; los binarios o más grandes se avisan y no se
  comparan.
- La comparación de directorios se hace por **tamaño y fecha**, no por contenido (para no descargar
  miles de archivos). Un archivo con el mismo tamaño y fecha distinta aparece como `mismo tamaño`:
  ábrelo y el diff te dirá si de verdad cambió. Si el tamaño difiere, es `distinto` con seguridad.
- El escaneo está acotado (20 000 archivos por lado) y marca el resultado como truncado. **Los archivos
  que quedan fuera del tope no aparecen en la lista en absoluto** (ni como iguales ni como distintos), así
  que si ves el aviso de truncado, compara carpetas más pequeñas para no dejar cambios sin revisar.
  Ajustar las exclusiones es la forma más rápida de bajar el conteo.
- El bastión comparte el secreto guardado del servidor.
- Los archivos que existen solo en el servidor se listan, pero no tienen versión local para comparar.
- En el modo web, "local" significa **el disco del equipo que ejecuta el servicio**, no el del navegador.
  Para desplegar desde tu portátil, ejecuta el modo servidor en tu portátil o monta el proyecto en el
  host del servicio.
- La terminal del modo web no conserva scrollback en el servidor: al recargar la página se pierde el
  historial visible (la sesión SSH sigue abierta). Varias pestañas comparten la misma sesión.
- Si se corta la conexión WebSocket durante una comparación, la petición se rechaza y el resultado no se
  entrega; vuelve a comparar cuando la conexión se restablezca.
- El modo servidor está pensado para un operador; no hay cuentas ni permisos por usuario. El token es
  único.
- La CSP y la validación de `Origin` asumen que el reverse proxy conserva el `Host`.
- **Subir por rutas** acepta hasta 200 rutas pegadas y 500 archivos por tanda; las rutas fuera del
  directorio local se rechazan. Los respaldos de `backup_files/<fecha>/` no se limpian solos: bórralos
  cuando ya no los necesites.
