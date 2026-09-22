#!/usr/bin/env bash
# =============================================================================
# install.sh - NotNativeDesktop simple source installation (macOS/Linux).
# Windows parity lives in install.ps1 (shortcuts + tray service there).
#
#   ./install.sh [install-dir]          default: $XDG_DATA_HOME/NotNativeDesktop
#   ./install.sh --uninstall [dir]      remove install tree (+ --purge-data)
# =============================================================================
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNINSTALL=0
PURGE=1
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --keep-data) PURGE=0 ;;
    *) ARGS+=("$arg") ;;
  esac
done
DATA_DIR="${ARGS[0]:-}"

if [[ -n "${XDG_DATA_HOME:-}" ]]; then
  DEFAULT_DIR="$XDG_DATA_HOME/NotNativeDesktop"
else
  DEFAULT_DIR="$HOME/.local/share/NotNativeDesktop"
fi
INSTALL_DIR="${DATA_DIR:-$DEFAULT_DIR}"

APP_ENTRIES_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

if [[ $UNINSTALL -eq 1 ]]; then
  echo "Uninstalling from $INSTALL_DIR"
  if [[ "$INSTALL_DIR" == "$SOURCE" ]]; then echo "refusing to delete the source repo"; exit 1; fi
  rm -rf "$INSTALL_DIR"
  rm -f "$APP_ENTRIES_DIR/notnativedesktop.desktop"
  if [[ $PURGE -eq 1 ]]; then
    rm -rf "$HOME/.notnative-desktop"
    echo "user data erased"
  fi
  echo "uninstall complete"
  exit 0
fi

[[ "$INSTALL_DIR" != "$SOURCE" ]] || { echo "install dir must differ from the source repo"; exit 1; }

echo "== NotNativeDesktop source install =="
echo "   source: $SOURCE"
echo "   target: $INSTALL_DIR"
command -v node >/dev/null || { echo "node is required on PATH"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required on PATH"; exit 1; }

echo "== copying source =="
mkdir -p "$INSTALL_DIR"
rsync -a "$SOURCE"/ "$INSTALL_DIR"/ \
  --exclude node_modules --exclude .git --exclude .vite --exclude coverage \
  --exclude dist --exclude dist-server --exclude dist-electron --exclude resources \
  --exclude '*.log' --exclude 'packaging-*.log' --exclude install-mode.txt

echo "== dependencies (pnpm install --frozen-lockfile) =="
( cd "$INSTALL_DIR" && pnpm install --frozen-lockfile )
if [[ ! -f "$INSTALL_DIR/packages/electron/node_modules/electron/dist/electron" ]]; then
  echo "== electron postinstall repair =="
  ( cd "$INSTALL_DIR/packages/electron/node_modules/electron" && node install.js )
fi

echo "== stamping scripted-install identity =="
printf 'script' > "$INSTALL_DIR/packages/electron/install-mode.txt"

echo "== building shell artifacts =="
( cd "$INSTALL_DIR" && node scripts/electron-package.mjs --no-nsis )

echo "== desktop entry =="
mkdir -p "$APP_ENTRIES_DIR"
cat > "$APP_ENTRIES_DIR/notnativedesktop.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=NotNativeDesktop
Exec=$INSTALL_DIR/packages/electron/node_modules/electron/dist/electron "$INSTALL_DIR/packages/electron/main.mjs"
Path=$INSTALL_DIR
Icon=$INSTALL_DIR/packages/electron/node_modules/electron/dist/electron
Comment=NotNativeDesktop - local service + tray
Categories=Development;
ENTRY
if command -v update-desktop-database >/dev/null; then update-desktop-database "$APP_ENTRIES_DIR" || true; fi

echo "== done =="
echo "   start   : your desktop launcher (tray icon appears immediately)"
echo "   logs    : ~/.config/NotNativeDesktop*/logs/main.log"
echo "   data    : ~/.notnative-desktop"
echo "   uninstall: ./install.sh --uninstall [--keep-data]"
