// SPDX-License-Identifier: Apache-2.0
import { saveTabPool } from './tab-pool.js';

export class WorkspaceTabPersistence {
  #tail = Promise.resolve();

  constructor(options) {
    this.options = options;
  }

  save() {
    if (!this.options.enabled()) return Promise.resolve();
    const { tabs, activeId } = this.options.snapshot();
    const write = this.#tail.then(() => (this.options.writer ?? saveTabPool)(
      this.options.path, tabs, activeId, { consoleId: this.options.consoleId },
    ));
    // The original write reports failure; this tail only preserves sequencing.
    this.#tail = write.catch(() => undefined);
    return write;
  }

  observe(operation, tasks) {
    const task = this.recover(operation)
      .finally(() => tasks.delete(task));
    tasks.add(task);
  }

  async recover(operation = this.save()) {
    try { await operation; return true; }
    catch (error) { this.options.onFailure(error); return false; }
  }

  wait() {
    return this.#tail;
  }
}
