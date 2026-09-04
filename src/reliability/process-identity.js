// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const PROBE_TIMEOUT_MS = 2_000;
const MAX_PROBE_BYTES = 4_096;
const SELF_IDENTITIES = new Map();

export class ProcessIdentity {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.kill = options.kill ?? process.kill;
    this.readFile = options.readFile ?? readFile;
    this.runProbe = options.runProbe ?? runProbe;
  }

  async capture(pid) {
    if (!this.live(pid)) return null;
    const key = pid === process.pid ? `${this.platform}:${pid}` : null;
    let pending = key ? SELF_IDENTITIES.get(key) : null;
    if (!pending) {
      pending = this.#startId(pid).catch(() => null);
      if (key) SELF_IDENTITIES.set(key, pending);
    }
    const startId = await pending;
    if (key && !startId && SELF_IDENTITIES.get(key) === pending) SELF_IDENTITIES.delete(key);
    return Object.freeze({ version: 1, pid, platform: this.platform, start_id: startId });
  }

  async compare(identity) {
    if (!validIdentity(identity) || identity.platform !== this.platform) return 'unknown';
    if (!this.live(identity.pid)) return 'dead';
    if (!identity.start_id) return 'unknown';
    const current = await this.#startId(identity.pid).catch(() => null);
    if (!current) return 'unknown';
    return current === identity.start_id ? 'same' : 'different';
  }

  live(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { this.kill(pid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
  }

  legacyPidFileMatches(identity, modifiedMs) {
    if (!validIdentity(identity) || identity.platform !== 'win32' || this.platform !== 'win32'
      || !Number.isFinite(modifiedMs) || modifiedMs <= 0 || !/^\d+$/u.test(identity.start_id ?? '')) return false;
    const windowsEpochTicks = 621_355_968_000_000_000n;
    const modifiedTicks = windowsEpochTicks + BigInt(Math.trunc(modifiedMs)) * 10_000n;
    const startedTicks = BigInt(identity.start_id);
    const delay = modifiedTicks - startedTicks;
    return delay >= 0n && delay <= 60n * 10_000_000n;
  }

  async #startId(pid) {
    if (this.platform === 'linux') return linuxStartId(await this.readFile(`/proc/${pid}/stat`, 'utf8'));
    if (this.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      return boundedId(await this.runProbe('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]));
    }
    return boundedId(await this.runProbe('ps', ['-o', 'lstart=', '-p', String(pid)]));
  }
}

export function validIdentity(value) {
  return value && typeof value === 'object' && value.version === 1
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.platform === 'string'
    && (value.start_id === null || (typeof value.start_id === 'string' && value.start_id.length > 0 && value.start_id.length <= 256));
}

function linuxStartId(value) {
  const close = value.lastIndexOf(')');
  const fields = close >= 0 ? value.slice(close + 1).trim().split(/\s+/u) : [];
  return boundedId(fields[19]);
}

function boundedId(value) {
  const normalized = String(value ?? '').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 256) throw Object.assign(new Error('process start identity unavailable'), { code: 'process_identity_unavailable' });
  return normalized;
}

function runProbe(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', bytes = 0, settled = false;
    const finish = (operation) => { if (settled) return; settled = true; clearTimeout(timer); operation(); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(Object.assign(new Error('process identity probe timed out'), { code: 'process_identity_timeout' }))); }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes <= MAX_PROBE_BYTES) output += chunk.toString('utf8'); else child.kill(); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code) => finish(() => code === 0 && bytes <= MAX_PROBE_BYTES ? resolve(output) : reject(Object.assign(new Error('process identity probe failed'), { code: 'process_identity_unavailable' }))));
  });
}
