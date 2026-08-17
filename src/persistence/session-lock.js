// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from '../ids.js';
import { ProcessIdentity, validIdentity } from '../reliability/process-identity.js';

const MAX_STALE_LOCK_ARTIFACTS = 1024;

export class SessionLock {
  #token = randomUUID();
  #owned = false;

  constructor(root, sessionId, options = {}) {
    this.root = root;
    this.path = join(root, `${sessionId}.lock`);
    this.identity = options.processIdentity ?? new ProcessIdentity();
  }

  async acquire() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Atomic creation precedes owner inspection; live locks do not expire by age.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#create();
        this.#owned = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const status = await inspectSessionLock(this.path, { processIdentity: this.identity });
        if (['live', 'unknown'].includes(status.status)) throw new ContractError('session_locked', 'another live or unverifiable writer owns this session');
        await this.#preserveStale(attempt);
      }
    }
    throw new ContractError('session_lock_race', 'session lock could not be acquired safely');
  }

  async release() {
    if (!this.#owned) return;
    let record;
    try {
      record = JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      this.#owned = false;
      return;
    }
    if (validLockRecord(record) && record.token !== this.#token) {
      this.#owned = false;
      throw new ContractError('session_lock_ownership_lost', 'session lock ownership changed before release');
    }
    if (validLockRecord(record)) await unlink(this.path).catch(() => undefined);
    this.#owned = false;
  }

  async health() {
    const names = await readdir(this.root).catch(() => []);
    const prefix = `${this.path.slice(this.root.length + 1)}.stale.`;
    return Object.freeze({
      status: 'ready', owned: this.#owned, path: this.path,
      preservedStaleEvidence: names.filter((name) => name.startsWith(prefix)).slice(0, 10_000).length,
    });
  }

  async #create() {
    const handle = await open(this.path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({
        version: 2, pid: process.pid, token: this.#token,
        process_identity: await this.identity.capture(process.pid),
        created_at: new Date().toISOString(),
      }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #preserveStale(attempt) {
    const stale = `${this.path}.stale.${Date.now()}.${attempt}.${randomUUID()}`;
    try {
      await rename(this.path, stale);
      await this.#pruneStaleEvidence();
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
    }
  }

  async #pruneStaleEvidence() {
    const prefix = `${this.path.slice(this.root.length + 1)}.stale.`;
    const names = (await readdir(this.root)).filter((name) => name.startsWith(prefix));
    if (names.length <= MAX_STALE_LOCK_ARTIFACTS) return;
    names.sort((left, right) => staleTimestamp(left, prefix) - staleTimestamp(right, prefix));
    await Promise.allSettled(names.slice(0, names.length - MAX_STALE_LOCK_ARTIFACTS)
      .map((name) => unlink(join(this.root, name))));
  }
}

function validLockRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [1, 2].includes(value.version)
    && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.token === 'string' && value.token.length > 0
    && typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at));
}

export async function inspectSessionLock(path, options = {}) {
  const identity = options.processIdentity ?? new ProcessIdentity();
  let record;
  try { record = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? { status: 'missing', record: null } : { status: 'malformed', record: null }; }
  if (!validLockRecord(record)) return { status: 'malformed', record };
  if (validIdentity(record.process_identity)) {
    const comparison = await identity.compare(record.process_identity);
    return { status: comparison === 'same' ? 'live' : comparison, record };
  }
  return { status: identity.live(record.pid) ? 'unknown' : 'dead', record };
}

export async function preserveStaleSessionLock(path, options = {}) {
  const inspected = await inspectSessionLock(path, options);
  if (inspected.status === 'missing') return Object.freeze({ repaired: false, status: 'missing' });
  if (['live', 'unknown'].includes(inspected.status)) {
    throw new ContractError('session_locked', 'session lock still belongs to a live or unverifiable process');
  }
  const stale = `${path}.stale.${Date.now()}.repair.${randomUUID()}`;
  await rename(path, stale);
  return Object.freeze({ repaired: true, status: inspected.status, evidence_path: stale });
}

function staleTimestamp(name, prefix) {
  const timestamp = Number(name.slice(prefix.length).split('.', 1)[0]);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
