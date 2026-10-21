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
| `npm run test:diff` | Pruebas del motor de diff/merge (incluye fuzzing) |
| `npm run package` | Empaqueta con electron-builder (descarga sus herramientas la primera vez) |

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
    store.ts       perfiles, secretos cifrados, known_hosts y auditoría
    validate.ts    validadores de entrada
    ssh/
      manager.ts   pool de sesiones, canales, host key y 2FA
      sftp.ts      operaciones SFTP, walk recursivo y escritura atómica
      compare.ts   comparación de directorios y lectura de pares de archivos
  preload/         puente seguro (contextBridge) hacia el renderer
  renderer/        interfaz React
    src/lib/       motor de diff (Myers) y construcción del merge
    src/components Sidebar, Terminal, Comparar y Diff
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
- **SFTP no notifica cambios**: el árbol se refresca al comparar o al subir; no hay vigilancia remota.

## Límites conocidos

- El diff solo aplica a archivos de texto y de hasta 4 MB; los binarios o más grandes se avisan y no se
  comparan.
- El escaneo de directorios está acotado (20 000 entradas por lado) y marca el resultado como truncado.
- El bastión comparte el secreto guardado del servidor.
- Los archivos que existen solo en el servidor se listan, pero no tienen versión local para comparar.
