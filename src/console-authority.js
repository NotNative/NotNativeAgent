// SPDX-License-Identifier: Apache-2.0
import { dirname } from 'node:path';
import { SessionLock } from './session-lock.js';

export class ConsoleAuthority {
  constructor(path, lock = undefined) {
    this.lock = lock ?? (path ? new SessionLock(dirname(path), 'console-authority') : null);
    this.owned = false;
  }

  async acquire() {
    if (!this.lock) { this.owned = true; return true; }
    try { await this.lock.acquire(); this.owned = true; }
    catch (error) {
      if (error?.code !== 'session_locked') throw error;
      this.owned = false;
    }
    return this.owned;
  }

  release() { return this.lock?.release(); }
}
