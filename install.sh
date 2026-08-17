#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$script_dir
system_name=$(uname -s)
case "$system_name" in
  Linux) platform_name=linux; install_root=${XDG_DATA_HOME:-"$HOME/.local/share"}/not-native-agent ;;
  Darwin) platform_name=darwin; install_root="$HOME/Library/Application Support/NotNativeAgent" ;;
  *) printf '%s\n' "Unsupported operating system: $system_name" >&2; exit 1 ;;
esac
data_root="$HOME/.nna"
web_search_mode=prompt
web_search_endpoint=''
gateway_mode=prompt
playwright_mode=prompt
provider_mode=prompt
telegram_token=''
telegram_user_id=''

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  c_cyan='\033[36m'; c_green='\033[32m'; c_yellow='\033[33m'; c_magenta='\033[35m'; c_white='\033[37m'; c_dim='\033[90m'; c_reset='\033[0m'
else
  c_cyan=''; c_green=''; c_yellow=''; c_magenta=''; c_white=''; c_dim=''; c_reset=''
fi
section() { printf '\n%b== %s ==%b\n' "$c_cyan" "$1" "$c_reset"; }
step() { printf '%b  > %s%b\n' "$c_dim" "$1" "$c_reset"; }
ok() { printf '%b [OK] %s%b\n' "$c_green" "$1" "$c_reset"; }
skip() { printf '%b [--] %s%b\n' "$c_dim" "$1" "$c_reset"; }
warn() { printf '%b [!!] %s%b\n' "$c_yellow" "$1" "$c_reset"; }
brand() {
  printf '\n%b NNA // INSTALLER%b\n' "$c_magenta" "$c_reset"
  printf '%b NotNativeAgent%b\n' "$c_white" "$c_reset"
  printf '%b Local-first agent runtime%b\n' "$c_dim" "$c_reset"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) source_root=$2; shift 2 ;;
    --install-root) install_root=$2; shift 2 ;;
    --data-root) data_root=$2; shift 2 ;;
    --skip-websearch-setup) web_search_mode=skip; shift ;;
    --skip-playwright-setup) playwright_mode=skip; shift ;;
    --skip-provider-setup) provider_mode=skip; shift ;;
    --skip-ripgrep-setup) NNA_SKIP_RIPGREP_SETUP=1; shift ;;
    --deploy-local-search) web_search_mode=local; shift ;;
    --websearch-endpoint) web_search_mode=endpoint; web_search_endpoint=$2; shift 2 ;;
    --skip-gateway-setup) gateway_mode=skip; shift ;;
    --telegram-token) gateway_mode=configure; telegram_token=$2; shift 2 ;;
    --telegram-user-id) gateway_mode=configure; telegram_user_id=$2; shift 2 ;;
    *) printf '%s\n' "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$source_root" in /*) ;; *) printf '%s\n' 'Source root must be absolute.' >&2; exit 1 ;; esac
case "$install_root" in /|"$HOME"|'') printf '%s\n' 'Unsafe install root.' >&2; exit 1 ;; /*) ;; *) printf '%s\n' 'Install root must be absolute.' >&2; exit 1 ;; esac
case "$data_root" in /|"$HOME"|'') printf '%s\n' 'Unsafe data root.' >&2; exit 1 ;; /*) ;; *) printf '%s\n' 'Data root must be absolute.' >&2; exit 1 ;; esac

brand
section 'Runtime readiness'
step 'Locating a compatible Node.js 24+ runtime'

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; return; fi
  command -v sudo >/dev/null 2>&1 || { printf '%s\n' 'Installing download utilities requires root or sudo.' >&2; exit 1; }
  sudo "$@"
}

ensure_ripgrep() {
  if command -v rg >/dev/null 2>&1; then ok "$(rg --version | head -n 1)"; return; fi
  warn 'ripgrep was not found; NNA will retain its slower native search fallback'
  if [ "${NNA_SKIP_RIPGREP_SETUP:-0}" = 1 ] || [ "${NNA_SKIP_DEPENDENCY_INSTALL:-0}" = 1 ]; then
    skip 'Optional ripgrep installation skipped by request'; return
  fi
  answer=n
  if [ -t 0 ]; then printf 'Install ripgrep search acceleration now? [Y/n] '; IFS= read -r answer || answer=n; [ -n "$answer" ] || answer=y; fi
  case "$answer" in n|N|no|NO) skip 'Optional ripgrep installation declined; native search remains available'; return ;; esac
  step 'Installing ripgrep with the available package manager'
  installed=false
  if [ "$platform_name" = darwin ] && command -v brew >/dev/null 2>&1; then brew install ripgrep && installed=true
  elif command -v apt-get >/dev/null 2>&1; then as_root apt-get update && as_root apt-get install -y ripgrep && installed=true
  elif command -v dnf >/dev/null 2>&1; then as_root dnf install -y ripgrep && installed=true
  elif command -v yum >/dev/null 2>&1; then as_root yum install -y ripgrep && installed=true
  elif command -v zypper >/dev/null 2>&1; then as_root zypper --non-interactive install ripgrep && installed=true
  fi
  if [ "$installed" = true ] && command -v rg >/dev/null 2>&1; then ok "$(rg --version | head -n 1)"
  else warn 'No supported package manager installed ripgrep; NNA will use native search'; fi
}

ensure_download_tools() {
  missing=false
  required_tools='curl tar'
  if [ "$platform_name" = linux ]; then required_tools="$required_tools xz sha256sum"; else required_tools="$required_tools shasum"; fi
  for tool in $required_tools; do command -v "$tool" >/dev/null 2>&1 || missing=true; done
  [ "$missing" = false ] && return
  printf '%s\n' 'Installing required download and archive utilities.' >&2
  if [ "$platform_name" = darwin ]; then
    printf '%s\n' 'macOS requires the built-in curl, tar, and shasum utilities.' >&2
    exit 1
  elif command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update >&2
    as_root apt-get install -y ca-certificates curl xz-utils tar coreutils >&2
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y ca-certificates curl xz tar coreutils >&2
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y ca-certificates curl xz tar coreutils >&2
  elif command -v zypper >/dev/null 2>&1; then
    as_root zypper --non-interactive install ca-certificates curl xz tar coreutils >&2
  else
    printf '%s\n' 'No supported package manager found; install curl, tar, xz, and sha256sum.' >&2
    exit 1
  fi
  for tool in $required_tools; do command -v "$tool" >/dev/null 2>&1 || { printf '%s\n' "Dependency installation did not provide $tool." >&2; exit 1; }; done
}

find_npm() {
  node_dir=$(dirname -- "$node_path")
  if [ -f "$node_dir/npm" ] && [ -x "$node_dir/npm" ]; then printf '%s\n' "$node_dir/npm"; return; fi
  command -v npm 2>/dev/null || true
}

nna_runtime() {
  NNA_HOME="$data_root" "$node_path" --disable-warning=ExperimentalWarning "$target/src/cli.js" "$@"
}

install_managed_playwright() {
  playwright_version=1.61.1 # Keep aligned with the runtime compatibility tests before updating.
  managed_root="$data_root/managed/playwright"
  browser_root="$managed_root/browsers"
  node_dir=$(dirname -- "$node_path")
  npm_path=$(find_npm)
  if [ -z "$npm_path" ]; then warn 'npm was not found; Playwright was not installed'; return 1; fi
  mkdir -p "$managed_root" "$browser_root"
  chmod 700 "$data_root/managed" "$managed_root" "$browser_root" 2>/dev/null || true
  step 'Installing the optional Playwright library'
  PATH="$node_dir:$PATH" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "$npm_path" install --prefix "$managed_root" --no-audit --no-fund --omit=dev --loglevel=error "playwright@$playwright_version" || {
    warn 'Playwright package installation failed'; return 1;
  }
  step 'Downloading Playwright Chromium'
  PLAYWRIGHT_BROWSERS_PATH="$browser_root" "$node_path" "$managed_root/node_modules/playwright/cli.js" install chromium || {
    warn 'Playwright Chromium download failed'; return 1;
  }
  verified=$(PLAYWRIGHT_BROWSERS_PATH="$browser_root" nna_runtime webbrowse verify) || {
    warn 'Playwright installed but Chromium launch validation failed'; return 1;
  }
  version=$(printf '%s' "$verified" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).version||'unknown')}catch{process.stdout.write('unknown')}})")
  ok "Playwright Chromium ready (v$version)"
}

archive_checksum() {
  if [ "$platform_name" = darwin ]; then shasum -a 256 "$1" | awk '{ print $1 }'; else sha256sum "$1" | awk '{ print $1 }'; fi
}

install_user_node() {
  ensure_download_tools
  case "$(uname -m)" in
    x86_64|amd64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) printf '%s\n' "Unsupported $system_name architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  if [ "$platform_name" = darwin ]; then archive_extension=tar.gz; else archive_extension=tar.xz; fi
  node_base=${NNA_NODE_DOWNLOAD_BASE:-https://nodejs.org/dist/latest-v24.x}
  runtime_root="$install_root/runtime"
  mkdir -p "$runtime_root"
  download_root=$(mktemp -d "$runtime_root/.download.XXXXXX")
  trap 'rm -rf -- "$download_root"' EXIT HUP INT TERM
  curl --fail --silent --show-error --location "$node_base/SHASUMS256.txt" --output "$download_root/SHASUMS256.txt"
  archive=$(awk -v a="$node_arch" -v p="$platform_name" -v e="$archive_extension" '$2 ~ ("^node-v[0-9.]+-" p "-" a "\\." e "$") { print $2; exit }' "$download_root/SHASUMS256.txt")
  expected=$(awk -v f="$archive" '$2 == f { print $1; exit }' "$download_root/SHASUMS256.txt")
  [ -n "$archive" ] && [ -n "$expected" ] || { printf '%s\n' "Official Node.js checksums do not contain a $platform_name $node_arch archive." >&2; exit 1; }
  case "$archive" in node-v*-"$platform_name"-"$node_arch"."$archive_extension") ;; *) printf '%s\n' 'Unsafe Node.js archive name.' >&2; exit 1 ;; esac
  curl --fail --silent --show-error --location "$node_base/$archive" --output "$download_root/$archive"
  actual=$(archive_checksum "$download_root/$archive")
  [ "$actual" = "$expected" ] || { printf '%s\n' 'Downloaded Node.js archive failed SHA-256 verification.' >&2; exit 1; }
  if [ "$platform_name" = darwin ]; then tar -xzf "$download_root/$archive" -C "$download_root"; else tar -xJf "$download_root/$archive" -C "$download_root"; fi
  directory=${archive%.$archive_extension}
  [ -d "$download_root/$directory" ] && [ ! -L "$download_root/$directory" ] && [ -x "$download_root/$directory/bin/node" ] || {
    printf '%s\n' 'Downloaded Node.js archive has an invalid runtime layout.' >&2; exit 1;
  }
  runtime_target="$runtime_root/$directory"
  case "$runtime_target" in "$runtime_root"/*) ;; *) printf '%s\n' 'Unsafe runtime path.' >&2; exit 1 ;; esac
  if [ -e "$runtime_target" ]; then
    [ -x "$runtime_target/bin/node" ] || { printf '%s\n' 'Refusing to replace a foreign runtime directory.' >&2; exit 1; }
    rm -rf -- "$runtime_target"
  fi
  mv "$download_root/$directory" "$runtime_target"
  trap - EXIT HUP INT TERM
  rm -rf -- "$download_root"
  printf '%s\n' "$runtime_target/bin/node"
}

node_path=''
if [ "${NNA_FORCE_BUNDLED_NODE:-0}" != '1' ] && command -v node >/dev/null 2>&1; then
  candidate=$(command -v node)
  node_major=$("$candidate" -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')
  if [ "$node_major" -ge 24 ] 2>/dev/null; then node_path=$candidate; fi
fi
if [ -z "$node_path" ] && [ "${NNA_FORCE_BUNDLED_NODE:-0}" != '1' ]; then
  candidate=$(find "$install_root/runtime" -type f -path '*/bin/node' -perm -u+x 2>/dev/null | head -n 1 || true)
  if [ -n "$candidate" ]; then
    node_major=$("$candidate" -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')
    if [ "$node_major" -ge 24 ] 2>/dev/null; then node_path=$candidate; fi
  fi
fi
if [ -z "$node_path" ]; then
  [ "${NNA_SKIP_DEPENDENCY_INSTALL:-0}" != '1' ] || { printf '%s\n' 'Node.js 24 or newer is missing and dependency installation was disabled.' >&2; exit 1; }
  printf '%s\n' 'A compatible Node.js runtime was not found; installing the latest official Node.js 24 LTS binary for this user.' >&2
  node_path=$(install_user_node)
  node_major=$("$node_path" -p "process.versions.node.split('.')[0]")
fi
[ "$node_major" -ge 24 ] || { printf '%s\n' 'Installed Node.js dependency validation failed.' >&2; exit 1; }
[ -f "$source_root/package.json" ] || { printf '%s\n' 'package.json was not found in the source root.' >&2; exit 1; }
package_name=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.name)" "$source_root/package.json")
[ "$package_name" = 'not-native-agent' ] || { printf '%s\n' 'The source directory is not a NotNativeAgent release.' >&2; exit 1; }
version=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.nna_version||p.version)" "$source_root/package.json")
node_version=$("$node_path" -p 'process.versions.node')
ok "Release manifest: $version"
ok "Node.js v$node_version"
printf '%b      %s%b\n' "$c_dim" "$node_path" "$c_reset"
ensure_ripgrep
gateway_stopped_for_upgrade=false
gateway_was_systemd=false

section 'Application payload'
step "Staging version $version"
target="$install_root/installed"
stage="$install_root/.installed.staging-$$"
mkdir -p "$install_root"
case "$stage" in "$install_root"/*) ;; *) printf '%s\n' 'Unsafe staging path.' >&2; exit 1 ;; esac
rm -rf -- "$stage"
mkdir -p "$stage/src"
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
cp -R "$source_root/src/." "$stage/src/"
cp -R "$source_root/docs" "$stage/docs"
rm -rf -- "$stage/docs/planning"
cp -R "$source_root/resources" "$stage/resources"
for file in package.json LICENSE NOTICE SECURITY.md SUPPORT.md THIRD_PARTY_NOTICES.md SBOM.spdx.json; do
  [ -f "$source_root/$file" ] || { printf '%s\n' "Release file is missing: $file" >&2; exit 1; }
  cp "$source_root/$file" "$stage/$file"
done
case "$target" in "$install_root"/*) ;; *) printf '%s\n' 'Unsafe installed path.' >&2; exit 1 ;; esac
if [ -e "$target" ]; then
  [ -f "$target/package.json" ] || { printf '%s\n' 'Refusing to replace an unmarked version directory.' >&2; exit 1; }
  target_name=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.name)" "$target/package.json")
  [ "$target_name" = 'not-native-agent' ] || { printf '%s\n' 'Refusing to replace a foreign version directory.' >&2; exit 1; }
  if [ "$platform_name" = linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet notnativeagent-telegram.service; then
    step 'Stopping the running Telegram gateway service before replacing its runtime files'
    systemctl --user stop notnativeagent-telegram.service
    gateway_stopped_for_upgrade=true
    gateway_was_systemd=true
  else
    incoming_gateway_status=$(NNA_HOME="$data_root" "$node_path" --disable-warning=ExperimentalWarning "$source_root/src/cli.js" gateway status)
    incoming_gateway_running=$(printf '%s' "$incoming_gateway_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).runtime?.running?'true':'false'))")
    if [ "$incoming_gateway_running" = true ]; then
      step 'Stopping the running Telegram gateway before replacing its runtime files'
      NNA_HOME="$data_root" "$node_path" --disable-warning=ExperimentalWarning "$source_root/src/cli.js" gateway stop >/dev/null
      gateway_attempt=0
      while [ "$gateway_attempt" -lt 300 ]; do
        sleep 0.1
        incoming_gateway_status=$(NNA_HOME="$data_root" "$node_path" --disable-warning=ExperimentalWarning "$source_root/src/cli.js" gateway status)
        incoming_gateway_running=$(printf '%s' "$incoming_gateway_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).runtime?.running?'true':'false'))")
        [ "$incoming_gateway_running" = true ] || break
        gateway_attempt=$((gateway_attempt + 1))
      done
      [ "$incoming_gateway_running" = false ] || { printf '%s\n' 'Telegram gateway did not stop within 30 seconds; existing runtime files were preserved.' >&2; exit 1; }
      gateway_stopped_for_upgrade=true
    fi
  fi
fi
rm -rf -- "$target"
mv "$stage" "$target"
trap - EXIT HUP INT TERM
mkdir -p "$install_root/transitory"
chmod 700 "$install_root/transitory"
ok 'Runtime files installed'
printf '%b      %s%b\n' "$c_dim" "$target" "$c_reset"

section 'User data and security'
step 'Preparing durable sessions, configuration, logs, and support storage'
delete_allowed=false
if [ ! -e "$data_root" ]; then
  delete_allowed=true
elif [ -f "$data_root/.nna-install.json" ]; then
  prior_deletable=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.product==='NotNativeAgent'&&p.deletable===true?'true':'false')" "$data_root/.nna-install.json")
  [ "$prior_deletable" = 'true' ] && delete_allowed=true
fi
mkdir -p "$data_root/sessions" "$data_root/reviewer-ledger" "$data_root/config" "$data_root/logs" "$data_root/support"
chmod 700 "$data_root" "$data_root/sessions" "$data_root/reviewer-ledger" "$data_root/config" "$data_root/logs" "$data_root/support"
"$node_path" -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({product:'NotNativeAgent',data_root:process.argv[2],created_by:process.argv[4]+'-installer',deletable:process.argv[3]==='true'})+'\\n',{mode:0o600})" "$data_root/.nna-install.json" "$data_root" "$delete_allowed" "$platform_name"
chmod 600 "$data_root/.nna-install.json"
ok 'User data directories prepared with restricted permissions'
printf '%b      %s%b\n' "$c_dim" "$data_root" "$c_reset"

section 'Interactive WebBrowse'
browse_status=$(nna_runtime webbrowse status)
browse_available=$(printf '%s' "$browse_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).available?'true':'false'))")
if [ "$browse_available" = true ]; then
  browse_version=$(printf '%s' "$browse_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).version||''))")
  skip "Playwright Chromium v$browse_version is already installed; setup skipped."
elif [ "$playwright_mode" = skip ] || [ "${NNA_SKIP_DEPENDENCY_INSTALL:-0}" = 1 ]; then
  skip 'Optional Playwright installation skipped by request'
elif [ -t 0 ] && [ -t 1 ]; then
  printf '%s' 'Install Playwright Chromium for interactive WebBrowse? [y/N] '
  read -r configure_browse
  case "$configure_browse" in y|Y|yes|YES) install_managed_playwright || true ;; *) skip 'Optional Playwright installation declined' ;; esac
else
  skip 'Non-interactive install detected; optional Playwright setup skipped'
fi

section 'Command launcher'
bin_root="$HOME/.local/bin"
mkdir -p "$bin_root"
cp "$source_root/uninstall.sh" "$install_root/uninstall.sh"
chmod 700 "$install_root/uninstall.sh"
chmod 755 "$target/src/cli.js"
rm -f -- "$bin_root/nna"
shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
quoted_node=$(shell_quote "$node_path")
quoted_cli=$(shell_quote "$target/src/cli.js")
quoted_data=$(shell_quote "$data_root")
printf '#!/bin/sh\nexport NNA_HOME=%s\nexec %s --disable-warning=ExperimentalWarning %s "$@"\n' "$quoted_data" "$quoted_node" "$quoted_cli" > "$bin_root/nna"
chmod 755 "$bin_root/nna"
"$node_path" -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({product:'NotNativeAgent',version:process.argv[2],install_root:process.argv[3],data_root:process.argv[4],node:process.argv[5],node_major:Number(process.argv[6])})+'\\n',{mode:0o600})" "$install_root/install.json" "$version" "$install_root" "$data_root" "$node_path" "$node_major"
ok 'NNA launcher written'
printf '%b      %s%b\n' "$c_dim" "$bin_root/nna" "$c_reset"
printf '%b      Uninstaller: %s%b\n' "$c_dim" "$install_root/uninstall.sh" "$c_reset"

section 'Initial provider profile'
provider_status=$(nna_runtime provider status)
provider_configured=$(printf '%s' "$provider_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).configured?'true':'false'))")
if [ "$provider_configured" = true ]; then
  skip 'Provider profile already configured; setup skipped.'
elif [ "$provider_mode" = prompt ] && [ -t 0 ] && [ -t 1 ]; then
  provider_endpoint=''
  while [ -z "$provider_endpoint" ]; do
    printf '%s' 'OpenAI-compatible provider URL (example: http://127.0.0.1:1234/v1): '
    read -r provider_endpoint
  done
  printf '%s' 'Provider API key (leave blank if authentication is not required): '
  stty -echo
  read -r provider_key
  stty echo
  printf '\n'
  step 'Discovering available models from the provider'
  discovery_json=$(printf '%s\n' "$provider_key" | nna_runtime provider discover "$provider_endpoint")
  model_count=$(printf '%s' "$discovery_json" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).models.length)))")
  index=1
  while [ "$index" -le "$model_count" ]; do
    model=$(printf '%s' "$discovery_json" | "$node_path" -e "let s='';const i=Number(process.argv[1]);process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).models[i]))" "$((index - 1))")
    printf '  %3d. %s\n' "$index" "$model"
    index=$((index + 1))
  done
  selected_model=''
  while [ -z "$selected_model" ]; do
    printf '%s' 'Choose a model by number or exact model name: '
    read -r selection
    selected_model=$(printf '%s' "$discovery_json" | "$node_path" -e "let s='';const v=process.argv[1];process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s).models;const n=Number(v);const x=Number.isInteger(n)&&n>=1&&n<=m.length?m[n-1]:m.find(i=>i===v);process.stdout.write(x||'')})" "$selection")
    [ -n "$selected_model" ] || printf '%s\n' 'Enter a listed number or an exact model name.' >&2
  done
  configured_json=$(printf '%s\n' "$provider_key" | nna_runtime provider configure "$provider_endpoint" "$selected_model")
  configured_endpoint=$(printf '%s' "$configured_json" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).endpoint))")
  ok "Provider configured: $configured_endpoint / $selected_model"
  unset provider_key
else
  skip 'Interactive provider setup skipped; run NNA to configure a provider later'
fi

section 'WebSearch integration'
search_status=$(nna_runtime websearch status)
search_configured=$(printf '%s' "$search_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).configured?'true':'false'))")
if [ "$search_configured" = true ]; then
  search_endpoint=$(printf '%s' "$search_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).config.endpoint||''))")
  search_managed=$(printf '%s' "$search_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).config.managed?'true':'false'))")
  if [ "$search_managed" = true ]; then
    step 'Checking the NNA-managed SearXNG deployment profile'
    if refresh_status=$(nna_runtime websearch refresh-managed); then
      search_refreshed=$(printf '%s' "$refresh_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).refreshed?'true':'false'))")
      if [ "$search_refreshed" = true ]; then
        ok 'Managed SearXNG configuration refreshed and container restarted'
      else
        skip 'Managed SearXNG configuration is current; setup skipped.'
      fi
    else
      warn 'Managed SearXNG refresh was deferred; use /websearch to inspect or redeploy it.'
    fi
  else
    skip "WebSearch is already configured at $search_endpoint; setup skipped."
  fi
elif [ "$web_search_mode" = endpoint ]; then
  step "Validating existing SearXNG endpoint: $web_search_endpoint"
  nna_runtime websearch configure "$web_search_endpoint" >/dev/null
  ok "WebSearch configured at $web_search_endpoint"
elif [ "$web_search_mode" = local ]; then
  step 'Checking Docker and deploying loopback-only SearXNG'
  nna_runtime websearch deploy >/dev/null
  ok 'Loopback-only SearXNG deployed and configured'
elif [ "$web_search_mode" = prompt ] && [ -t 0 ] && [ -t 1 ]; then
  printf '%s' 'Configure WebSearch now? [y/N] '
  read -r configure_search
  case "$configure_search" in
    y|Y|yes|YES)
      printf '%s' 'Enter the base URL of your existing SearXNG server (example: http://192.168.1.50:8080), or leave blank to deploy a new local instance with Docker: '
      read -r endpoint
      if [ -n "$endpoint" ]; then
        nna_runtime websearch configure "$endpoint" >/dev/null
      else
        nna_runtime websearch deploy >/dev/null
      fi
      ok 'WebSearch configured and validated' ;;
  esac
else
  skip 'WebSearch setup not requested'
fi

section 'Telegram gateway'
gateway_status=$(nna_runtime gateway status)
gateway_configured=$(printf '%s' "$gateway_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).configured?'true':'false'))")
gateway_users=$(printf '%s' "$gateway_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).authorized_user_ids.length)))")
gateway_running=$(printf '%s' "$gateway_status" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).runtime?.running?'true':'false'))")
[ "$gateway_stopped_for_upgrade" = true ] && gateway_running=true
if [ "$gateway_configured" = true ] && [ "$gateway_users" -gt 0 ]; then
  skip "Telegram gateway is already configured for $gateway_users authorized operator(s)."
elif [ "$gateway_mode" = prompt ] && [ -t 0 ] && [ -t 1 ]; then
  printf '%s' 'Configure the Telegram gateway now? [y/N] '
  read -r configure_gateway
  case "$configure_gateway" in
    y|Y|yes|YES)
      printf '%s' 'Telegram bot token from BotFather: '
      stty -echo; read -r telegram_token; stty echo; printf '\n'
      printf '%s' 'Numeric Telegram user ID to authorize: '
      read -r telegram_user_id
      gateway_mode=configure ;;
  esac
fi
if [ "$gateway_mode" = configure ]; then
  [ -n "$telegram_token" ] && [ -n "$telegram_user_id" ] || { printf '%s\n' 'Telegram token and user ID are both required.' >&2; exit 1; }
  step 'Saving the bot token in restricted local configuration'
  printf '%s\n' "$telegram_token" | nna_runtime gateway token-stdin >/dev/null
  nna_runtime gateway authorize "$telegram_user_id" >/dev/null
  gateway_workspace="$data_root/gateway/workspace"
  mkdir -p "$gateway_workspace"
  chmod 700 "$gateway_workspace"
  nna_runtime gateway workspace "$gateway_workspace" >/dev/null
  nna_runtime gateway enable >/dev/null
  nna_runtime gateway test >/dev/null
  if [ "$platform_name" = linux ] && command -v systemctl >/dev/null 2>&1; then
    service_root="$HOME/.config/systemd/user"
    mkdir -p "$service_root"
    cat > "$service_root/notnativeagent-telegram.service" <<EOF
[Unit]
Description=NotNativeAgent Telegram gateway
After=network-online.target
[Service]
Type=simple
Environment="NNA_HOME=$data_root"
ExecStart="$node_path" --disable-warning=ExperimentalWarning "$target/src/cli.js" gateway run
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF
    if systemctl --user daemon-reload >/dev/null 2>&1; then
      systemctl --user enable --now notnativeagent-telegram.service >/dev/null
    else
      nna_runtime gateway start >/dev/null
    fi
  else
    nna_runtime gateway start >/dev/null
  fi
  unset telegram_token
  ok 'Telegram bot validated and gateway started'
elif [ "$gateway_mode" = skip ]; then
  skip 'Telegram gateway setup not requested'
fi
if [ "$gateway_running" = true ] && [ "$gateway_mode" != configure ]; then
  step 'Restarting the running Telegram gateway on the updated runtime'
  if [ "$gateway_was_systemd" = true ]; then
    systemctl --user start notnativeagent-telegram.service
  elif [ "$platform_name" = linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet notnativeagent-telegram.service; then
    systemctl --user restart notnativeagent-telegram.service
  else
    nna_runtime gateway stop >/dev/null
    gateway_stopped=false
    gateway_attempt=0
    while [ "$gateway_attempt" -lt 300 ]; do
      sleep 0.1
      gateway_runtime=$(nna_runtime gateway status)
      gateway_still_running=$(printf '%s' "$gateway_runtime" | "$node_path" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).runtime?.running?'true':'false'))")
      if [ "$gateway_still_running" = false ]; then gateway_stopped=true; break; fi
      gateway_attempt=$((gateway_attempt + 1))
    done
    [ "$gateway_stopped" = true ] || { printf '%s\n' 'Telegram gateway did not stop within 30 seconds; refusing to start a duplicate runtime.' >&2; exit 1; }
    nna_runtime gateway start >/dev/null
  fi
  ok 'Telegram gateway restarted on the updated runtime'
fi

section 'Verification'
step 'Launching the installed CLI and checking its canonical version'
installed_version=$(nna_runtime --version)
case "$installed_version" in *"$version"*) ;; *) printf '%s\n' 'Installed CLI version verification failed.' >&2; exit 1 ;; esac
ok "$installed_version"

printf '\n%b INSTALL COMPLETE%b\n' "$c_magenta" "$c_reset"
printf '%b Version     %s%b\n' "$c_white" "$version" "$c_reset"
printf '%b Application %s%b\n' "$c_dim" "$target" "$c_reset"
printf '%b User data   %s%b\n' "$c_dim" "$data_root" "$c_reset"
case ":$PATH:" in
  *":$bin_root:"*) printf '%b Next step   Run: nna%b\n' "$c_cyan" "$c_reset" ;;
  *) printf '%b Next step   Add %s to PATH, then run: nna%b\n' "$c_cyan" "$bin_root" "$c_reset" ;;
esac
