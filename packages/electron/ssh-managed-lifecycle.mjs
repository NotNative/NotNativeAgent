// SPDX-License-Identifier: Apache-2.0
import { parseDesktopSshCommand } from './ssh-instances.mjs';

function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value); }
function validPort(value) { return Number.isInteger(value) && value >= 1 && value <= 65_535; }

/** Remote dependency setup and detached server lifecycle for uploaded bundles. */
export function createManagedSshLifecycle({ runRemoteScript } = {}) {
  if (typeof runRemoteScript !== 'function') throw new TypeError('runRemoteScript is required');

  function validate(instance, transferId) {
    try { parseDesktopSshCommand(instance?.sshCommand); }
    catch { throw new Error('desktop-ssh-instance-invalid'); }
    if (!validId(transferId) || !validId(instance?.id)) throw new Error('managed-ssh-id-invalid');
  }

  async function installAndStart(instance, { transferId, port }) {
    validate(instance, transferId);
    if (!validPort(port)) throw new Error('managed-ssh-port-invalid');
    const method = ['auto', 'npm', 'bun'].includes(instance.remoteOpenchamber?.installMethod)
      ? instance.remoteOpenchamber.installMethod : 'auto';
    const script = [
      'set -eu',
      `root="$HOME/.notnative-desktop/managed/${transferId}"`,
      'test -s "$root/server.mjs" && test -f "$root/start-managed.mjs" && test -d "$root/web-dist" || { echo "managed bundle is incomplete" >&2; exit 72; }',
      'cd "$root"',
      'command -v node >/dev/null 2>&1 && node -e \'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)\' || { echo "Node.js >=22.18 is required for this managed instance" >&2; exit 71; }',
      'if ! node -e \'require("node-pty")\' >/dev/null 2>&1; then',
      method === 'bun'
        ? '  command -v bun >/dev/null 2>&1 || { echo "bun is required for this managed instance" >&2; exit 71; }; bun install --production --no-progress'
        : method === 'npm'
          ? '  command -v npm >/dev/null 2>&1 || { echo "npm is required for this managed instance" >&2; exit 71; }; npm install --omit=dev --no-audit --no-fund'
          : '  if command -v bun >/dev/null 2>&1; then bun install --production --no-progress; elif command -v npm >/dev/null 2>&1; then npm install --omit=dev --no-audit --no-fund; else echo "npm or bun is required" >&2; exit 71; fi',
      'fi',
      'node -e \'require("node-pty")\' >/dev/null 2>&1 || { echo "node-pty dependency installation is incomplete" >&2; exit 73; }',
      `data="$HOME/.notnative-desktop/data/${instance.id}"`,
      'mkdir -p -- "$data"',
      `nohup env NOTNATIVE_PORT=${port} NOTNATIVE_HOST=127.0.0.1 NOTNATIVE_DIST_DIR="$root/web-dist" NOTNATIVE_DATA_DIR="$data" node "$root/start-managed.mjs" >"$root/server.log" 2>&1 </dev/null &`,
      'pid=$!',
      'printf "%s\\n" "$pid" >"$root/server.pid"',
      'sleep 1',
      'kill -0 "$pid"',
      `printf 'NOTNATIVE_STARTED_PID=%s PORT=${port}\\n' "$pid"`,
      '',
    ].join('\n');
    const result = await runRemoteScript(instance, script, { timeoutMs: 10 * 60_000 });
    if (result.code !== 0) throw new Error('managed-ssh-server-start-failed');
    const ready = /^NOTNATIVE_STARTED_PID=(\d+) PORT=(\d+)$/mu.exec(result.stdout);
    if (!ready || Number(ready[2]) !== port) throw new Error('managed-ssh-server-start-unconfirmed');
    return { transferId, pid: Number(ready[1]), port };
  }

  async function stop(instance, transferId) {
    validate(instance, transferId);
    const script = [
      'set -eu',
      `root="$HOME/.notnative-desktop/managed/${transferId}"`,
      'pidfile="$root/server.pid"',
      'if [ -f "$pidfile" ]; then',
      '  IFS= read -r pid <"$pidfile" || true',
      '  case "$pid" in (*[!0-9]*|"") pid="";; esac',
      '  if [ -n "$pid" ]; then',
      '    command=$(ps -p "$pid" -o args= 2>/dev/null || true)',
      '    case "$command" in *"$root/start-managed.mjs"*)',
      '      kill "$pid" 2>/dev/null || true',
      '      attempt=0',
      '      while [ "$attempt" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.25; attempt=$((attempt + 1)); done',
      '      if kill -0 "$pid" 2>/dev/null; then',
      '        command=$(ps -p "$pid" -o args= 2>/dev/null || true)',
      '        case "$command" in *"$root/start-managed.mjs"*) kill -9 "$pid" 2>/dev/null || true;; esac',
      '      fi',
      '      ;; esac',
      '  fi',
      '  rm -f -- "$pidfile"',
      'fi',
      'rm -rf -- "$root"',
      '',
    ].join('\n');
    const result = await runRemoteScript(instance, script);
    if (result.code !== 0) throw new Error('managed-ssh-server-stop-failed');
    return true;
  }

  return { installAndStart, stop };
}
