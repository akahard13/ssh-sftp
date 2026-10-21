# SSH · SFTP Manager

App de escritorio para administrar **múltiples sesiones SSH** contra servidores privados, con terminal
interactiva y un comparador de directorios que permite **subir solo los cambios seleccionados** por SFTP.

No abre varias ventanas: mantiene una sesión (y sus canales) por servidor y tú eliges cuál usar.

## Requisitos

- Node.js 20 o superior (probado con 22).
- Windows en el equipo cliente (la ventana usa `safeStorage`/DPAPI para cifrar secretos).
- Acceso de red a los servidores (VPN o bastión si aplica).

## Instalación

```powershell
npm install
npm run dev        # desarrollo con recarga en caliente
```

Si `npm install` no descarga el binario de Electron (proxy/red restringida):

```powershell
node node_modules/electron/install.js
```

## Comandos

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Compila main/preload y lanza la app con Vite en modo desarrollo |
| `npm run build` | Compila `out/` para producción |
| `npm run typecheck` | Verifica tipos de los proyectos Node y Web |
| `npm test` | Pruebas del motor de diff/merge y del recorrido de directorios |
| `npm run package` | Genera el **instalador NSIS** en `dist/` (necesario para auto-update) |
| `npm run package:dir` | Genera solo la carpeta portable `dist/win-unpacked` (sin instalador) |
| `npm run release` | Igual que `package` y además publica el release en GitHub (requiere `GH_TOKEN`) |

## Flujo de uso

1. **Agregar servidor**: nombre, host, puerto, usuario y método de autenticación (llave privada,
   `ssh-agent` o contraseña). Opcionalmente un directorio remoto base, uno local y un bastión.
2. **Conectar**: al primer contacto la app muestra la huella del host; hay que verificarla y confiar en
   ella antes de que se guarde en `known_hosts`.
3. **Terminal**: pestaña `Terminal`, sesión completa sobre `xterm-256color` con redimensionado real.
4. **Comparar / Subir**: elige el directorio local y el del servidor, pulsa `Comparar` y verás el árbol
   con el estado de cada archivo (`solo local`, `solo servidor`, `distinto`, `igual`).
5. **Revisar un archivo**: se abre el diff a dos columnas (servidor ↔ local) con un bloque seleccionable
   por cada cambio, más un tercer panel con el **archivo generado**.
6. **Subir**: `Subir seleccionados` escribe en el servidor solo los bloques marcados, de forma atómica y
   con respaldo opcional.

## Actualizaciones (auto-update)

La app usa `electron-updater` contra **GitHub Releases**. Antes de la primera publicación hay que
rellenar en [package.json](./package.json) (`build.publish`) el `owner` y el `repo` reales; hasta
entonces la app muestra "Actualizaciones no configuradas" y no intenta descargar nada.

### Requisitos

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

### Cómo publicar una versión

```powershell
# 1. Sube la versión en package.json ("version": "0.1.1")
# 2. Crea y sube el tag ANTES de publicar (ver nota abajo)
git tag v0.1.1
git push origin v0.1.1
# 3. Compila y publica
$env:GH_TOKEN = "github_pat_..."
npm run release
```

> **El tag debe existir antes.** GitHub rechaza crear un release *publicado* cuyo tag todavía no
> existe, y devuelve un error con código `custom` que electron-builder no reconoce como recuperable
> (solo sabe tratar `already_exists`). Resultado: el build se corta y el release queda creado a medias.
> Creando el tag primero el problema desaparece.
>
> Si un release queda incompleto, **vuelve a ejecutar `npm run release`**: al detectar el release
> existente (publicado hace menos de 2 horas) vuelve a subir los archivos y sobreescribe los que ya
> estaban. Verifica siempre que el release tenga **3 assets**: el `.exe`, el `.blockmap` y `latest.yml`.
> Sin `latest.yml` la app no puede actualizarse.

Esto sube el `.exe` del instalador, el `latest.yml` y el `.blockmap` al release de GitHub. El
`.blockmap` es lo que permite descargas diferenciales: solo se bajan los bloques que cambiaron.

> El nombre del archivo local ya está fijado como `SSH-SFTP-Manager-<versión>-setup.exe`, que es
> exactamente el que espera `latest.yml`. Si publicas el release **a mano** en vez de con
> `npm run release`, sube el archivo sin renombrarlo: cualquier cambio de nombre hace que la app reciba
> un 404 al buscar la actualización.

### Cómo se comporta la app

- Verifica al arrancar (15 s después) y luego cada 6 horas; también hay un botón manual "Buscar
  actualizaciones" en el panel inferior de la barra lateral.
- Descarga **solo si el usuario lo pide** (`autoDownload = false`) y muestra el progreso.
- Al terminar avisa "reiniciar e instalar"; si no, aplica la actualización al cerrar la app
  (`autoInstallOnAppQuit = true`).

### Advertencia de seguridad

Con auto-update, quien controle el canal de releases ejecuta código en todas las máquinas. Por eso:

- El token debe ser **fine-grained, de solo lectura de `Contents` y limitado a ese repo**, y rotarse
  si se filtra. Nunca lo pongas dentro del código de la app.
- El canal va por HTTPS de GitHub, pero **sin firma de código** Windows seguirá mostrando SmartScreen
  como editor desconocido. Si la empresa consigue un certificado, configurar `win.certificateFile` /
  `CSC_LINK` en electron-builder es el siguiente paso natural.
- Para volver a una versión anterior hay que republicar con un número de versión **mayor**, porque el
  updater solo compara versiones.

## Modelo de seguridad

- **Verificación de host key obligatoria** (TOFU con `known_hosts` propio). Si la huella cambia, la
  conexión se bloquea y se avisa; nunca se acepta automáticamente.
- **Secretos cifrados** con `safeStorage` (DPAPI en Windows) en un archivo aparte con permisos `0600`.
  Las contraseñas y passphrases nunca llegan al proceso de renderizado ni se escriben en logs.
- **Proceso de renderizado aislado**: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, sin `webview`, CSP estricta en producción y navegación bloqueada.
- **Superficie IPC mínima** y validada: cada mensaje se comprueba campo por campo antes de usarse.
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

## Estructura

```
src/
  main/            proceso principal de Electron
    index.ts       ventana, ciclo de vida y endurecimiento
    ipc.ts         superficie IPC con validación
    updater.ts     auto-actualización (electron-updater)
    store.ts       perfiles, secretos cifrados, known_hosts y auditoría
    validate.ts    validadores de entrada
    ssh/
      manager.ts   pool de sesiones, canales, host key y 2FA
      sftp.ts      operaciones SFTP, walk recursivo y escritura atómica
      compare.ts   comparación de directorios y lectura de pares de archivos
  preload/         puente seguro (contextBridge) hacia el renderer
  renderer/        interfaz React
    src/lib/       motor de diff (Myers) y construcción del merge
    src/components Sidebar, Terminal, Comparar, Diff y panel de actualizaciones
  shared/          tipos y contrato de la API
tools/difftest.ts  pruebas del motor de diff
```

## Decisiones de diseño

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
- **Exclusiones por defecto**: `node_modules`, `vendor`, `.git`, `storage`, `dist`, `build` y similares
  se omiten en ambos lados, y el número de carpetas omitidas se muestra en la lista.
- **SFTP no notifica cambios**: el árbol se refresca al comparar o al subir; no hay vigilancia remota.

## Límites conocidos

- `build.publish` en [package.json](./package.json) tiene `owner`/`repo` de ejemplo: hay que
  rellenarlos con el repositorio real antes de publicar releases.
- No hay firma de código, así que SmartScreen avisará como editor desconocido.
- El diff solo aplica a archivos de texto y de hasta 4 MB; los binarios o más grandes se avisan y no se
  comparan.
- La comparación de directorios se hace por **tamaño y fecha**, no por contenido (para no descargar
  miles de archivos). Un archivo con el mismo tamaño y fecha distinta aparece como `mismo tamaño`:
  ábrelo y el diff te dirá si de verdad cambió. Si el tamaño difiere, es `distinto` con seguridad.
- El escaneo está acotado (20 000 archivos por lado) y marca el resultado como truncado. Las carpetas
  pesadas se excluyen por defecto; la lista no es configurable desde la interfaz.
- El bastión comparte el secreto guardado del servidor.
- Los archivos que existen solo en el servidor se listan, pero no tienen versión local para comparar.
