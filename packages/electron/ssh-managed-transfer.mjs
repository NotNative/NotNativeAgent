// SPDX-License-Identifier: Apache-2.0
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseDesktopSshCommand } from './ssh-instances.mjs';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const FORBIDDEN_FORWARDING_OPTIONS = new Set([
  'clearallforwardings', 'dynamicforward', 'forwardagent', 'forwardx11',
  'localforward', 'remoteforward',
]);

function hasForwardingOption(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = arg === '-o' ? args[index + 1] : arg.startsWith('-o') ? arg.slice(2) : null;
    if (!value) continue;
    const name = value.trim().split(/[=\s]/u, 1)[0].toLowerCase();
    if (FORBIDDEN_FORWARDING_OPTIONS.has(name)) return true;
    if (arg === '-o') index += 1;
  }
  return false;
}

function appendBounded(chunks, chunk, current, limit, errorCode, child, fail) {
  const bytes = Buffer.from(chunk);
  const size = current + bytes.length;
  if (size > limit) {
    try { child.kill(); } catch {}
    fail(new Error(errorCode));
    return current;
  }
  chunks.push(bytes);
  return size;
}

/** Upload a gzip USTAR archive into a private per-attempt remote directory. */
export function createManagedSshBundleUploader({ spawnProcess = nodeSpawn, platform = process.platform, timeoutMs = 10 * 60_000 } = {}) {
  return function uploadManagedBundle(instance, archive, { id = randomUUID() } = {}) {
    if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
      return Promise.reject(new Error('managed-ssh-archive-invalid-or-too-large'));
    }
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) {
      return Promise.reject(new Error('managed-ssh-transfer-id-invalid'));
    }
    let parsed;
    try { parsed = parseDesktopSshCommand(instance?.sshCommand); }
    catch { return Promise.reject(new Error('desktop-ssh-instance-invalid')); }
    const forbiddenForwarding = new Set(['-A', '-D', '-L', '-R', '-X', '-Y']);
    if (parsed.args.some((arg) => forbiddenForwarding.has(arg)
      || [...forbiddenForwarding].some((flag) => arg.startsWith(flag) && arg !== flag))
      || hasForwardingOption(parsed.args)) {
      return Promise.reject(new Error('desktop-ssh-command-forwarding-options-unsupported'));
    }
    const executable = platform === 'win32' ? 'ssh.exe' : 'ssh';
    const remotePath = `"$HOME/.notnative-desktop/managed/${id}"`;
    const remoteParent = '"$HOME/.notnative-desktop/managed"';
    // The per-attempt leaf must not already exist. `mkdir -p` on the leaf
    // would merge a retry into stale contents (and follows a pre-existing
    // symlink), so only the fixed parent is created recursively.
    const remoteCommand = `umask 077 && mkdir -p -- ${remoteParent} && mkdir -- ${remotePath} && tar -xzf - -C ${remotePath}`;
    const args = [
      ...parsed.args,
      '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
      '-o', 'PermitLocalCommand=no', '-T', parsed.destination, remoteCommand,
    ];
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(new Error('managed-ssh-transfer-spawn-failed')); return; }
      const stderr = [];
      let stderrSize = 0;
      let stdoutSize = 0;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(new Error('managed-ssh-transfer-timeout'));
      }, Math.min(10 * 60_000, Math.max(1_000, timeoutMs)));
      child.stdout?.on('data', (chunk) => {
        // Tar should be silent on success. Bound unexpected remote output too.
        stdoutSize = appendBounded([], chunk, stdoutSize, MAX_STDERR_BYTES, 'managed-ssh-transfer-output-too-large', child, finish);
      });
      child.stderr?.on('data', (chunk) => {
        stderrSize = appendBounded(stderr, chunk, stderrSize, MAX_STDERR_BYTES, 'managed-ssh-transfer-error-output-too-large', child, finish);
      });
      child.once('error', () => finish(new Error('managed-ssh-transfer-process-failed')));
      child.once('close', (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error(`managed-ssh-transfer-failed-${Number.isInteger(code) ? code : 'unknown'}`));
          return;
        }
        finish(null, { remoteDirectory: `~/.notnative-desktop/managed/${id}`, stderr: Buffer.concat(stderr).toString('utf8'), signal: signal ?? null });
      });
      child.stdin?.once('error', () => {
        try { child.kill(); } catch {}
        finish(new Error('managed-ssh-transfer-stream-failed'));
      });
      try { child.stdin.end(archive); }
      catch {
        try { child.kill(); } catch {}
        finish(new Error('managed-ssh-transfer-stream-failed'));
      }
    });
  };
}
