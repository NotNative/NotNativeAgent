// SPDX-License-Identifier: Apache-2.0
import { spawn as nodeSpawn } from 'node:child_process';
import { parseDesktopSshCommand } from './ssh-instances.mjs';

const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;

export function shellQuote(value) {
  const text = String(value);
  if (/[\u0000\r\n]/u.test(text)) throw new Error('remote-shell-value-invalid');
  return `'${text.replace(/'/gu, "'\\''")}'`;
}

export function createSshRemoteCommandRunner({ spawnProcess = nodeSpawn, platform = process.platform, timeoutMs = 60_000 } = {}) {
  return function runRemoteScript(instance, script, options = {}) {
    if (typeof script !== 'string' || Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES || script.includes('\0')) {
      return Promise.reject(new Error('remote-script-invalid-or-too-large'));
    }
    let parsed;
    try { parsed = parseDesktopSshCommand(instance?.sshCommand); }
    catch { return Promise.reject(new Error('desktop-ssh-instance-invalid')); }
    const executable = platform === 'win32' ? 'ssh.exe' : 'ssh';
    const args = [...parsed.args, '-T', parsed.destination, 'sh -s'];
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(new Error('remote-ssh-spawn-failed')); return; }
      const stdout = [];
      const stderr = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* process already gone */ }
        finish(new Error('remote-ssh-command-timeout'));
      }, Math.min(10 * 60_000, Math.max(1_000, options.timeoutMs ?? timeoutMs)));
      child.stdout?.on('data', (chunk) => {
        const bytes = Buffer.from(chunk);
        stdoutSize += bytes.length;
        if (stdoutSize > MAX_STDOUT_BYTES) {
          try { child.kill(); } catch {}
          finish(new Error('remote-ssh-output-too-large'));
        } else stdout.push(bytes);
      });
      child.stderr?.on('data', (chunk) => {
        const bytes = Buffer.from(chunk);
        stderrSize += bytes.length;
        if (stderrSize > MAX_STDERR_BYTES) {
          try { child.kill(); } catch {}
          finish(new Error('remote-ssh-error-output-too-large'));
        } else stderr.push(bytes);
      });
      child.once('error', () => finish(new Error('remote-ssh-process-failed')));
      // `exit` may precede the final stdout/stderr data. Settle only after
      // `close`, which means both output pipes have drained.
      child.once('close', (code, signal) => {
        if (settled) return;
        const result = {
          code: Number.isInteger(code) ? code : 1,
          signal: signal ?? null,
          stdout: Buffer.concat(stdout).toString('utf8'),
          // Stderr is bounded and returned separately; callers must avoid
          // placing it in logs or renderer status without sanitizing it.
          stderr: Buffer.concat(stderr).toString('utf8'),
        };
        finish(null, result);
      });
      child.stdin?.once('error', () => {
        try { child.kill(); } catch { /* process already gone */ }
        finish(new Error('remote-ssh-script-send-failed'));
      });
      try { child.stdin.end(script); }
      catch { try { child.kill(); } catch {} finish(new Error('remote-ssh-script-send-failed')); }
    });
  };
}
