// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const source = (await readFile('install.sh', 'utf8')).replaceAll('\r\n', '\n');
const functions = ['opencode_runtime_running', 'stop_opencode_before_payload_replacement',
  'restore_opencode_after_payload_replacement'].map((name) => {
  const start = source.indexOf(`${name}() {`); assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');

async function upgrade(mode) {
  const root = (await mkdtemp(join(tmpdir(), 'nna-posix-opencode-'))).replaceAll('\\', '/');
  const script = `set -eu
${mode === 'timeout' ? functions.replace('"$opencode_attempt" -lt 300', '"$opencode_attempt" -lt 3') : functions}
fixture=${quote(root)}
mode=${quote(mode)}
node_path=node_stub
data_root='/fixture/user data'
source_root='/fixture/incoming payload'
target='/fixture/installed payload'
opencode_stopped_for_upgrade=false
step() { :; }
ok() { printf '%s\\n' "$*"; }
skip() { printf '%s\\n' "$*"; }
sleep() { :; }
nna_runtime() { NNA_HOME="$data_root" "$node_path" --disable-warning=ExperimentalWarning "$target/src/cli.js" "$@"; }
node_stub() {
  if [ "$1" = -e ]; then ${quote(process.execPath.replaceAll('\\', '/'))} "$@"; return; fi
  printf '%s|%s|%s\\n' "$2" "$4" "$NNA_HOME" >> "$fixture/actions"
  case "$4" in
    status)
      if [ "$mode" = status_failure ]; then return 1; fi
      if [ "$mode" = invalid_status ]; then printf '{}'; return; fi
      if [ "$mode" = poll_failure ] && [ -f "$fixture/stopping" ]; then return 1; fi
      if [ -f "$fixture/started" ]; then
        if [ "$mode" = restart_not_running ]; then printf '{"runtime":{"running":false}}';
        else printf '{"runtime":{"running":true}}'; fi
      elif [ "$mode" = stopped ]; then printf '{"runtime":{"running":false}}';
      elif [ -f "$fixture/stopping" ] && [ "$mode" != timeout ]; then
        if [ ! -f "$fixture/polled" ]; then touch "$fixture/polled"; printf '{"runtime":{"running":true}}';
        else printf '{"runtime":{"running":false}}'; fi
      else printf '{"runtime":{"running":true}}'; fi ;;
    stop)
      [ "$mode" != stop_failure ] || return 1
      touch "$fixture/stopping" ;;
    start)
      [ "$mode" != restart_failure ] || return 1
      touch "$fixture/started" ;;
    *) return 1 ;;
  esac
}
stop_opencode_before_payload_replacement
printf 'replace\\n' >> "$fixture/actions"
restore_opencode_after_payload_replacement
printf 'complete\\n' >> "$fixture/actions"
`;
  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const actions = await readFile(join(root, 'actions'), 'utf8');
  return { ...result, actions };
}

test('POSIX upgrade waits for graceful stop and restarts with the installed CLI and same data root', async () => {
  const result = await upgrade('running'); assert.equal(result.status, 0, result.stderr);
  const actions = result.actions.trim().split('\n');
  assert.deepEqual(actions.map((line) => line.includes('|') ? line.split('|')[1] : line),
    ['status', 'stop', 'status', 'status', 'replace', 'start', 'status', 'complete']);
  assert.ok(actions.slice(0, 4).every((line) => line.startsWith('/fixture/incoming payload/src/cli.js|')));
  assert.ok(actions.slice(5, 7).every((line) => line.startsWith('/fixture/installed payload/src/cli.js|')));
  assert.ok(actions.filter((line) => line.includes('|')).every((line) => line.endsWith('|/fixture/user data')));
});

test('stopped OpenCode runtime remains stopped during POSIX upgrade', async () => {
  const result = await upgrade('stopped'); assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.actions, /\|(stop|start)\|/u);
  assert.match(result.stdout, /stays stopped/u);
});

for (const mode of ['status_failure', 'invalid_status', 'stop_failure', 'poll_failure', 'timeout']) {
  test(`POSIX ${mode} preserves payload and prevents restart`, async () => {
    const result = await upgrade(mode);
    assert.equal(result.status, 1, result.stderr); assert.doesNotMatch(result.actions, /replace|\|start\|/u);
    assert.match(result.stderr, /existing runtime files were preserved/u);
    if (mode === 'timeout') assert.equal(result.actions.split('|status|').length - 1, 4);
  });
}

for (const mode of ['restart_failure', 'restart_not_running']) {
  test(`POSIX ${mode} reports failure without claiming a complete installation`, async () => {
    const result = await upgrade(mode); assert.equal(result.status, 1, result.stderr);
    assert.match(result.actions, /replace/u); assert.doesNotMatch(result.actions, /complete/u);
    assert.doesNotMatch(result.stdout, /restarted on the updated runtime/u);
  });
}

test('POSIX installer gates payload deletion and runs OpenCode restoration before verification', () => {
  assert.match(functions, /"\$opencode_attempt" -lt 300/u);
  const replacement = source.indexOf('rm -rf -- "$target"');
  assert.ok(source.lastIndexOf('\n  stop_opencode_before_payload_replacement\n') < replacement);
  assert.ok(source.indexOf("section 'OpenCode service'\nrestore_opencode_after_payload_replacement")
    < source.indexOf("section 'Verification'"));
});
