// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from '../ids.js';

export class SessionLock {
  #token = randomUUID();
  #owned = false;

  constructor(root, sessionId) {
    this.root = root;
    this.path = join(root, `${sessionId}.lock`);
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
        if (await this.#ownerIsLive()) throw new ContractError('session_locked', 'another live writer owns this session');
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
    if (validLockRecord(record) && record.token === this.#token) await unlink(this.path).catch(() => undefined);
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
        version: 1, pid: process.pid, token: this.#token,
        created_at: new Date().toISOString(),
      }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #ownerIsLive() {
    try {
      const record = JSON.parse(await readFile(this.path, 'utf8'));
      if (!validLockRecord(record)) return false;
      process.kill(record.pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }

  async #preserveStale(attempt) {
    const stale = `${this.path}.stale.${Date.now()}.${attempt}.${randomUUID()}`;
    try {
      await rename(this.path, stale);
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
    }
  }
}

function validLockRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.token === 'string' && value.token.length > 0
    && typeof value.created_at === 'string';
}
