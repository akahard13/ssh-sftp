#!/usr/bin/env bash
# Instalador de DeploySync en modo servidor web.
#
#   curl -fsSL https://raw.githubusercontent.com/akahard13/ssh-sftp/main/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --start
#
# Instala el paquete de npm y, opcionalmente, arranca el servidor web.
set -euo pipefail

PACKAGE="${DEPLOYSYNC_PACKAGE:-deploysync}"
VERSION="${DEPLOYSYNC_VERSION:-latest}"
PREFIX="${DEPLOYSYNC_PREFIX:-}"
PORT="${DEPLOYSYNC_PORT:-7777}"
HOST="${DEPLOYSYNC_HOST:-0.0.0.0}"
START=0
NO_OPEN=0

usage() {
  cat <<'EOF'
Uso: install.sh [opciones]

  --prefix <ruta>   Instala en esa ruta (por defecto: global de npm).
  --port <puerto>   Puerto del servidor al usar --start (por defecto 7777).
  --start           Arranca el servidor al terminar la instalación.
  --no-open         No abre el navegador al arrancar.
  -h, --help        Muestra esta ayuda.

Variables:
  DEPLOYSYNC_VERSION  Versión de npm a instalar (por defecto latest).
  DEPLOYSYNC_PREFIX   Equivale a --prefix.
  DEPLOYSYNC_HOST     Interfaz del servidor con --start (por defecto 0.0.0.0).
  DEPLOYSYNC_PORT     Puerto del servidor con --start (por defecto 7777).
EOF
}

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      [ "$#" -ge 2 ] || fail "Falta el valor de --prefix."
      PREFIX="$2"
      shift 2
      ;;
    --port)
      [ "$#" -ge 2 ] || fail "Falta el valor de --port."
      PORT="$2"
      shift 2
      ;;
    --start)
      START=1
      shift
      ;;
    --no-open)
      NO_OPEN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Opción desconocida: $1 (usa --help)."
      ;;
  esac
done

command -v node >/dev/null 2>&1 || fail "Node.js 20 o superior es obligatorio. Instálalo desde https://nodejs.org o con nvm."
command -v npm >/dev/null 2>&1 || fail "npm no está disponible en el PATH."

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Se requiere Node.js 20 o superior; tienes $(node -v)."
fi

SPEC="$PACKAGE@$VERSION"
case "$PACKAGE" in
  ./*|../*|/*|github:*|git+*) SPEC="$PACKAGE" ;;
esac

say "Instalando $SPEC para $(uname -s) $(uname -m)"

BIN=""
if [ -n "$PREFIX" ]; then
  npm install -g --prefix "$PREFIX" "$SPEC"
  BIN="$PREFIX/bin/deploysync"
else
  if npm install -g "$SPEC"; then
    GLOBAL_PREFIX="$(npm prefix -g)"
    BIN="$GLOBAL_PREFIX/bin/deploysync"
    [ -x "$BIN" ] || BIN="$GLOBAL_PREFIX/deploysync"
  else
    warn "La instalación global falló (¿permisos?). Reintentando en ~/.local…"
    mkdir -p "$HOME/.local"
    npm install -g --prefix "$HOME/.local" "$SPEC"
    BIN="$HOME/.local/bin/deploysync"
  fi
fi

if [ ! -x "$BIN" ]; then
  FOUND="$(command -v deploysync || true)"
  if [ -n "$FOUND" ]; then
    BIN="$FOUND"
  else
    fail "La instalación terminó pero no se encontró el comando deploysync."
  fi
fi

BIN_DIR="$(dirname "$BIN")"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "Añade $BIN_DIR al PATH para usar 'deploysync' en nuevas terminales:"
    warn "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

say "Instalado: $BIN"

if [ "$START" -eq 1 ]; then
  ARGS=(--host "$HOST" --port "$PORT")
  [ "$NO_OPEN" -eq 1 ] && ARGS+=(--no-open)
  say "Arrancando el servidor en http://$HOST:$PORT (Ctrl+C para detener)…"
  exec "$BIN" "${ARGS[@]}"
fi

cat <<EOF

Listo. Arranca el servidor con:

  deploysync --host 0.0.0.0 --port $PORT

La primera vez se genera un token en:
  ~/.config/deploysync/server-token   (Linux)
  ~/Library/Application Support/deploysync/server-token   (macOS)

Abre la URL con ?token=... que imprime el comando. Para arrancarlo ahora mismo:

  curl -fsSL https://raw.githubusercontent.com/akahard13/ssh-sftp/main/scripts/install.sh | bash -s -- --start

EOF
