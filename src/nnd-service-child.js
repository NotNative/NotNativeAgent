// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';

const LIMIT = 64 * 1024;
export function childEnvironment(identity) {
  const env = { NNA_HOME: identity.data_root };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
export function launchNndServiceChild(identity, entrypoint, bootstrap, options = {}) {
  return new NndChild(identity, entrypoint, bootstrap, options);
}
class NndChild {
  constructor(identity, entrypoint, bootstrap, options) {
    this.bootstrap = bootstrap; this.options = options; this.pending = new Map();
    this.buffer = Buffer.alloc(0); this.failed = false; this.sawReady = false;
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
    this.fatal = new Promise((resolve) => { this.resolveFatal = resolve; });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.child = (options.spawn ?? spawn)(identity.node, [entrypoint, '--supervised'], {
      cwd: identity.install_root, windowsHide: true, env: childEnvironment(identity), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.timer = setTimeout(() => this.fail('nnd_start_timeout'), options.startTimeoutMs ?? 15000);
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    // Security: drain diagnostics without retaining or echoing potential child secrets.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => { this.fail('nnd_service_crashed'); if (!this.child.pid) this.resolveExit(); });
    this.child.on('exit', () => { this.fail('nnd_service_crashed'); this.resolveExit(); });
    this.child.stdin.on('error', () => this.fail('nnd_service_crashed'));
    this.child.stdin.write(`${JSON.stringify(bootstrap)}\n`);
  }
  fail(code) {
    if (this.failed) return;
    this.failed = true; clearTimeout(this.timer);
    const error = new ContractError(code, 'NND child lifecycle failed');
    this.resolveFatal(error); this.rejectReady(error);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  frame(value) {
    const b = this.bootstrap;
    if (value?.type === 'failed') return this.fail('nnd_service_crashed');
    if (value?.protocol !== '1.0' || value.generation !== b.generation) return this.fail('nnd_service_protocol_invalid');
    if (value.type === 'ready') {
      if (this.sawReady || value.endpoint !== b.ui_origin || value.installation_id !== b.installation_id
        || value.data_id !== b.data_id || value.version !== this.options.version) return this.fail('nnd_service_protocol_invalid');
      this.sawReady = true; clearTimeout(this.timer); this.resolveReady(value); return;
    }
    const waiter = this.pending.get(value.request_id);
    if (!waiter || !['ui_ticket', 'stopped', 'error'].includes(value.type)) return this.fail('nnd_service_protocol_invalid');
    this.pending.delete(value.request_id); waiter.resolve(value);
  }
  consume(chunk) {
    if (this.failed) return;
    if (this.buffer.length + chunk.length > LIMIT) return this.fail('nnd_service_protocol_invalid');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index;
    while ((index = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1);
      try { this.frame(JSON.parse(line.toString('utf8'))); } catch { this.fail('nnd_service_protocol_invalid'); }
    }
  }
  async command(type) {
    if (this.failed || this.pending.size >= 16) throw new ContractError('nnd_service_crashed', 'NND child is unavailable');
    const request_id = randomUUID();
    let timeout;
    const response = new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      timeout = setTimeout(() => { this.pending.delete(request_id); reject(new ContractError('nnd_stop_timeout', 'NND child command timed out')); }, 5000);
    });
    this.child.stdin.write(`${JSON.stringify({ type, protocol: '1.0', generation: this.bootstrap.generation, request_id })}\n`);
    try { return await response; } finally { clearTimeout(timeout); }
  }
  close() { return this.closing ??= this.stop(); }
  async stop() {
    this.child.stdin.end();
    const kill = setTimeout(() => this.child.kill(), 3000);
    let deadline;
    try {
      await Promise.race([this.exited, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new ContractError('nnd_stop_timeout', 'Owned child did not exit')), 8000);
      })]);
    } finally { clearTimeout(kill); clearTimeout(deadline); }
  }
}
