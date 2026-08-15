// SPDX-License-Identifier: Apache-2.0
import { dirname } from 'node:path';
import { SessionLock } from '../persistence/session-lock.js';

const CONSOLE_AUTHORITY_LOCK_ID = 'console-authority';
const SESSION_LOCKED_CODE = 'session_locked';

/** Serializes ownership of the durable Console tab pool across processes and concurrent local callers. */
export class ConsoleAuthority {
  #operation = Promise.resolve();

  constructor(path, lock = undefined) {
    this.lock = lock ?? (path ? new SessionLock(dirname(path), CONSOLE_AUTHORITY_LOCK_ID) : null);
    this.owned = false;
  }

  async acquire() {
    return this.#enqueue(() => this.#acquire());
  }

  async release() {
    return this.#enqueue(() => this.#release());
  }

  async #acquire() {
    if (this.owned) return true;
    if (!this.lock) { this.owned = true; return true; }
    try { await this.lock.acquire(); this.owned = true; return true; }
    catch (error) {
      if (error?.code !== SESSION_LOCKED_CODE) throw error;
      this.owned = false;
      return false;
    }
  }

  async #release() {
    if (!this.owned) return undefined;
    try { return await this.lock?.release(); }
    finally { this.owned = false; }
  }

  #enqueue(operation) {
    const pending = this.#operation.then(operation, operation);
    this.#operation = pending.catch(() => undefined);
    return pending;
  }
}
