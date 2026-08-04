#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu

case "$(uname -s)" in
  Linux) install_root=${XDG_DATA_HOME:-"$HOME/.local/share"}/not-native-agent ;;
  Darwin) install_root="$HOME/Library/Application Support/NotNativeAgent" ;;
  *) printf '%s\n' "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
delete_data=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-root) install_root=$2; shift 2 ;;
    --delete-user-data) delete_data=1; shift ;;
    *) printf '%s\n' "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$install_root" in /|"$HOME"|'') printf '%s\n' 'Unsafe install root.' >&2; exit 1 ;; /*) ;; *) printf '%s\n' 'Install root must be absolute.' >&2; exit 1 ;; esac

marker="$install_root/install.json"
[ -f "$marker" ] || { printf '%s\n' 'Refusing to uninstall: NotNativeAgent install marker is missing.' >&2; exit 1; }
node_path=''
if command -v node >/dev/null 2>&1; then node_path=$(command -v node); fi
if [ -z "$node_path" ]; then node_path=$(find "$install_root/runtime" -type f -path '*/bin/node' -perm -u+x 2>/dev/null | head -n 1 || true); fi
[ -n "$node_path" ] && [ -x "$node_path" ] || { printf '%s\n' 'Refusing to uninstall: no usable Node.js runtime can validate the install marker.' >&2; exit 1; }
product=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.product)" "$marker")
marked_install_root=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.install_root)" "$marker")
data_root=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.data_root)" "$marker")
[ "$product" = 'NotNativeAgent' ] || { printf '%s\n' 'Refusing to uninstall: install marker is invalid.' >&2; exit 1; }
[ "$marked_install_root" = "$install_root" ] || { printf '%s\n' 'Refusing to uninstall: install marker does not match the requested directory.' >&2; exit 1; }

if [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now notnativeagent-telegram.service >/dev/null 2>&1 || true
  rm -f -- "$HOME/.config/systemd/user/notnativeagent-telegram.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
if [ -f "$install_root/installed/src/cli.js" ]; then
  NNA_HOME="$data_root" "$node_path" "$install_root/installed/src/cli.js" gateway stop >/dev/null 2>&1 || true
fi

if [ "$delete_data" -eq 1 ]; then
  data_marker="$data_root/.nna-install.json"
  [ -f "$data_marker" ] || { printf '%s\n' 'Refusing data deletion because its marker is missing.' >&2; exit 1; }
  data_product=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.product)" "$data_marker")
  marked_data_root=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.data_root)" "$data_marker")
  data_deletable=$("$node_path" -e "const p=require(process.argv[1]);process.stdout.write(p.deletable===true?'true':'false')" "$data_marker")
  [ "$data_product" = 'NotNativeAgent' ] || { printf '%s\n' 'Refusing data deletion because its marker is invalid.' >&2; exit 1; }
  [ "$marked_data_root" = "$data_root" ] || { printf '%s\n' 'Refusing data deletion because its marker does not match.' >&2; exit 1; }
  [ "$data_deletable" = 'true' ] || { printf '%s\n' 'Refusing to delete a pre-existing user data directory.' >&2; exit 1; }
  case "$data_root" in /|"$HOME"|'') printf '%s\n' 'Refusing an unsafe user data root.' >&2; exit 1 ;; esac
fi

rm -f -- "$HOME/.local/bin/nna"
rm -rf -- "$install_root"
printf '%s\n' "Removed NotNativeAgent from $install_root"

if [ "$delete_data" -eq 1 ]; then
  rm -rf -- "$data_root"
  printf '%s\n' "Deleted NotNativeAgent user data from $data_root; this cannot be recovered by the uninstaller."
else
  printf '%s\n' "Retained user data at $data_root"
fi
