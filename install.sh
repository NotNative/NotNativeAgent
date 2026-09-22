#!/usr/bin/env bash
# =============================================================================
# install.sh - NotNativeDesktop simple source installation (macOS/Linux).
# Windows parity lives in install.ps1 (shortcuts + tray service there).
# Static POSIX-parity file (authored without a bash host; review-only).
#
#   ./install.sh [install-dir]          default: $XDG_DATA_HOME/NotNativeDesktop
#   ./install.sh --uninstall [dir]      remove install tree (user data KEPT)
#   ./install.sh --uninstall --purge-data [dir]   also erase user data
#
# Data-erasure parity: like install.ps1 (-PurgeData is opt-in), --purge-data
# is opt-in here too (the original default-purge behavior was a cross-platform
# surprise: one platform preserved ~/.notnative-desktop by default, the other
# deleted it). The install dir must not contain whitespace: a .desktop Exec
# cannot safely quote its target and the Icon key takes one unquoted token.
# =============================================================================
# Bash-only constructs below (BASH_SOURCE, array +=). Running under sh/dash
# would otherwise die on `set -o pipefail` with an opaque parser error.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "install.sh requires bash, not sh (try: bash $0)" >&2
  exit 1
fi
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNINSTALL=0
PURGE=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --purge-data) PURGE=1 ;;
    --keep-data) PURGE=0 ;;  # accepted for compatibility; keep is now the default
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
  echo "Uninstalling from $INSTALL_DIR (user data kept unless --purge-data)"
  if [[ "$INSTALL_DIR" == "$SOURCE" ]]; then echo "refusing to delete the source repo"; exit 1; fi
  # POSIX note: a running install is unlinkable (rm deletes the inode while
  # the in-memory server keeps serving); no lock refusal is mirrored from
  # install.ps1 because deleting a live tree is safe here.
  rm -rf "$INSTALL_DIR"
  rm -f "$APP_ENTRIES_DIR/notnativedesktop.desktop"
  if [[ $PURGE -eq 1 ]]; then
    # Parity with install.ps1 -PurgeData: erase the shared data dir AND the
    # electron userData dirs (logs + port-prefs), not just the data dir.
    CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
    rm -rf "$HOME/.notnative-desktop" "$CONFIG_BASE/NotNativeDesktop" "$CONFIG_BASE/NotNativeDesktop Dev"
    echo "user data erased"
  fi
  echo "uninstall complete"
  exit 0
fi

[[ "$INSTALL_DIR" != "$SOURCE" ]] || { echo "install dir must differ from the source repo"; exit 1; }
case "$INSTALL_DIR" in
  *[[:space:]]*)
    echo "install dir must not contain whitespace (desktop-entry Exec/Icon cannot quote it): $INSTALL_DIR" >&2
    exit 1 ;;
esac

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

# Upgrade semantics: rsync -a is merge-only (files deleted upstream linger
# until a full reinstall) - mirrors install.ps1 robocopy /E on purpose. All
# runtime artifacts (bundle, sibling data, web dist, tray icons) regenerate
# wholesale below, so stale leftovers cannot change behavior.

echo "== dependencies (pnpm install --frozen-lockfile) =="
( cd "$INSTALL_DIR" && pnpm install --frozen-lockfile )
# electron's binary layout differs per OS; a missing binary triggers one
# repair pass of electron's own install.js (idempotent when already present).
if [[ "$(uname)" == "Darwin" ]]; then
  ELECTRON_BIN="$INSTALL_DIR/packages/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
else
  ELECTRON_BIN="$INSTALL_DIR/packages/electron/node_modules/electron/dist/electron"
fi
if [[ ! -f "$ELECTRON_BIN" ]]; then
  echo "== electron postinstall repair =="
  ( cd "$INSTALL_DIR/packages/electron/node_modules/electron" && node install.js )
fi

echo "== stamping scripted-install identity =="
printf 'script' > "$INSTALL_DIR/packages/electron/install-mode.txt"

echo "== building shell artifacts =="
( cd "$INSTALL_DIR" && node scripts/electron-package.mjs --no-nsis )

echo "== desktop entry =="
mkdir -p "$APP_ENTRIES_DIR"
# Exec args are double-quoted per the freedesktop spec; Icon needs a real
# image file (an ELF binary never renders).
cat > "$APP_ENTRIES_DIR/notnativedesktop.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=NotNativeDesktop
Exec="$ELECTRON_BIN" "$INSTALL_DIR/packages/electron/main.mjs"
Path=$INSTALL_DIR
Icon=$INSTALL_DIR/packages/electron/assets/tray-running.png
Comment=NotNativeDesktop - local service + tray
Categories=Development;
ENTRY
if command -v update-desktop-database >/dev/null; then update-desktop-database "$APP_ENTRIES_DIR" || true; fi

echo "== done =="
echo "   start   : your desktop launcher (tray icon appears immediately)"
echo "   logs    : ~/.config/NotNativeDesktop*/logs/main.log"
echo "   data    : ~/.notnative-desktop"
echo "   uninstall: ./install.sh --uninstall [--purge-data]"
