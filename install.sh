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
NNA_BOOTSTRAP=0
NNA_SOURCE_ROOT="$(dirname "$SOURCE")/NotNativeAgent"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --purge-data) PURGE=1; shift ;;
    --keep-data) PURGE=0; shift ;;  # accepted for compatibility; keep is now the default
    --install-nna-if-missing) NNA_BOOTSTRAP=1; shift ;;
    --nna-source-root) [[ $# -ge 2 ]] || { echo "--nna-source-root requires a path" >&2; exit 2; }; NNA_SOURCE_ROOT="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
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

find_nna_launcher() {
  local candidate="${HOME}/.local/bin/nna"
  [[ -x "$candidate" && -f "$candidate" ]] || return 1
  # NNA's installer writes this launcher and install.json together. A source
  # checkout CLI on PATH can answer `package status`, but is not an install.
  node -e 'const fs=require("fs"), path=require("path");
    const launcher=process.argv[1], source=fs.readFileSync(launcher,"utf8");
    const match=source.match(/\x27([^\x27\r\n]*\/installed\/src\/cli\.js)\x27/);
    if (!match) process.exit(1);
    const cli=match[1], root=path.dirname(path.dirname(path.dirname(cli)));
    if (process.env.NNA_INSTALL_ROOT && path.resolve(process.env.NNA_INSTALL_ROOT)!==path.resolve(root)) process.exit(1);
    const marker=JSON.parse(fs.readFileSync(path.join(root,"install.json"),"utf8"));
    if (marker.product!=="NotNativeAgent" || !path.isAbsolute(marker.install_root)
      || path.resolve(marker.install_root)!==path.resolve(root)
      || !path.isAbsolute(marker.node) || !fs.statSync(marker.node).isFile()
      || !path.isAbsolute(marker.data_root) || !fs.statSync(cli).isFile()) process.exit(1);' "$candidate" >/dev/null 2>&1 || return 2
  printf '%s\n' "$candidate"
}

# The NNA installation root, derived from the launcher's embedded CLI path.
nna_install_root() {
  node -e 'const fs=require("fs"), path=require("path");
    const source=fs.readFileSync(process.argv[1],"utf8");
    const match=source.match(/\x27([^\x27\r\n]*\/installed\/src\/cli\.js)\x27/);
    if (!match) process.exit(1);
    console.log(path.dirname(path.dirname(path.dirname(match[1]))));' "$1"
}

if [[ $UNINSTALL -eq 1 ]]; then
  echo "Uninstalling from $INSTALL_DIR (user data kept unless --purge-data)"
  if [[ "$INSTALL_DIR" == "$SOURCE" ]]; then echo "refusing to delete the source repo"; exit 1; fi
  if NNA_LAUNCHER="$(find_nna_launcher)"; then
    NNA_ROOT="$(nna_install_root "$NNA_LAUNCHER")" || NNA_ROOT=""
    # Best-effort stop first: a running old-version service would keep serving
    # from the deleted inode (parity with the Windows uninstall's stop).
    if [[ -n "$NNA_ROOT" ]]; then "$NNA_LAUNCHER" nnd service stop "$NNA_ROOT" >/dev/null 2>&1 || true; fi
    if ! "$NNA_LAUNCHER" nnd package status >/dev/null; then
      echo "NNA is installed but package status failed; refusing to erase an NND package that NNA may still reference" >&2
      exit 1
    fi
    "$NNA_LAUNCHER" nnd package deactivate "$INSTALL_DIR"
  else
    nna_result=$?
    if [[ $nna_result -eq 2 ]]; then
      echo "NNA launcher or installation is invalid; refusing to erase an NND package that NNA may still reference" >&2
      exit 1
    fi
    echo "NNA is unavailable; no live registration can be deactivated (preserved NNA data may retain a stale record)" >&2
  fi
  # POSIX note: a running install is unlinkable (rm deletes the inode while
  # the in-memory server keeps serving); no lock refusal is mirrored from
  # install.ps1 because deleting a live tree is safe here.
  rm -rf "$INSTALL_DIR"
  rm -f "$APP_ENTRIES_DIR/notnativeagent.desktop"
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
command -v node >/dev/null || { echo "node is required on PATH" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required on PATH" >&2; exit 1; }
if NNA_LAUNCHER="$(find_nna_launcher)"; then
  :
else
  nna_result=$?
  if [[ $nna_result -eq 2 ]]; then
    echo "NNA launcher or installation is invalid; repair NNA before installing NND" >&2
    exit 1
  fi
  if [[ ! -f "$NNA_SOURCE_ROOT/install.sh" || ! -f "$NNA_SOURCE_ROOT/package.json" ]]; then
    echo "NNA is not installed and no local NNA installer was found at $NNA_SOURCE_ROOT. Install NNA first or pass --nna-source-root." >&2
    exit 1
  fi
  if ! node -e 'const p=require(process.argv[1]); if (p.name !== "not-native-agent") process.exit(1)' "$NNA_SOURCE_ROOT/package.json" >/dev/null 2>&1; then
    echo "Local NNA source identity is invalid at $NNA_SOURCE_ROOT" >&2
    exit 1
  fi
  if [[ $NNA_BOOTSTRAP -ne 1 ]]; then
    [[ -t 0 ]] || { echo "NNA is not installed. Run interactively to confirm installation, or pass --install-nna-if-missing." >&2; exit 1; }
    read -r -p "NNA is required. Install it from $NNA_SOURCE_ROOT now? [y/N] " answer
    case "$answer" in y|Y|yes|YES) ;; *) echo "NNA installation declined; NND was not installed" >&2; exit 1 ;; esac
  fi
  echo "== installing required NNA from $NNA_SOURCE_ROOT =="
  if [[ $NNA_BOOTSTRAP -eq 1 ]]; then
    sh "$NNA_SOURCE_ROOT/install.sh" --skip-provider-setup --skip-websearch-setup --skip-playwright-setup --skip-gateway-setup --skip-ripgrep-setup
  else
    sh "$NNA_SOURCE_ROOT/install.sh"
  fi
  NNA_LAUNCHER="$(find_nna_launcher)" || { echo "NNA installer did not leave a valid installed runtime; NND was not installed" >&2; exit 1; }
fi
if ! "$NNA_LAUNCHER" nnd package status >/dev/null 2>&1; then
  echo "Installed NNA cannot inspect NND packages. Update or repair NNA, then rerun this installer." >&2
  exit 1
fi
echo "   NNA: $NNA_LAUNCHER"

# Upgrade parity with install.ps1's plan resolver: stop a running service
# before replacing its files. Best-effort - a stopped service is already fine.
NNA_ROOT="$(nna_install_root "$NNA_LAUNCHER")" || NNA_ROOT=""
if [[ -n "$NNA_ROOT" ]]; then "$NNA_LAUNCHER" nnd service stop "$NNA_ROOT" >/dev/null 2>&1 || true; fi

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

node -e 'const fs=require("fs"), path=require("path");
  const root=process.argv[1], version=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")).nnd_version;
  if (typeof version!=="string" || !/^\d{8}-[1-9]\d{0,5}$/.test(version)) throw new Error("Installed NND version is invalid");
  const dir=path.join(root,"nna-integration","nnd-local"); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"integration.json"),JSON.stringify({id:"nnd-local",ownership:"nnd",scope:"local-gui",nna_integration_protocol:"1.0",version}));' "$INSTALL_DIR"

echo "== registering NND package with NNA =="
"$NNA_LAUNCHER" nnd package activate "$INSTALL_DIR"

echo "== desktop entry =="
mkdir -p "$APP_ENTRIES_DIR"
# NNA brand icon from the installed NNA (fall back to the tray asset when the
# installed NNA predates the icon); Exec args are double-quoted per the
# freedesktop spec and Icon needs a real image file (an ELF binary never renders).
ENTRY_ICON="$NNA_ROOT/resources/icons/notnative-agent-32.png"
[[ -f "$ENTRY_ICON" ]] || ENTRY_ICON="$INSTALL_DIR/packages/electron/assets/tray-running.png"
cat > "$APP_ENTRIES_DIR/notnativeagent.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=NotNativeAgent
Exec="$ELECTRON_BIN" "$INSTALL_DIR/packages/electron/main.mjs"
Path=$INSTALL_DIR
Icon=$ENTRY_ICON
Comment=NotNativeAgent desktop
Categories=Development;
ENTRY
if command -v update-desktop-database >/dev/null; then update-desktop-database "$APP_ENTRIES_DIR" || true; fi

echo "== done =="
echo "   version : $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).nnd_version)' "$INSTALL_DIR/package.json")"
echo "   start   : your desktop launcher (tray icon appears immediately), or: nna desktop start"
echo "   stop    : nna desktop stop;  auto-start at logon: nna desktop enable / disable"
echo "   status  : nna desktop status"
echo "   logs    : ~/.config/NotNativeDesktop*/logs/main.log"
echo "   data    : ~/.notnative-desktop"
echo "   uninstall: ./install.sh --uninstall [--purge-data]"
