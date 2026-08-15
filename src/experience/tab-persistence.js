// SPDX-License-Identifier: Apache-2.0
import { saveTabPool } from './tab-pool.js';
import { ContractError } from '../ids.js';

export class WorkspaceTabPersistence {
  #tail = Promise.resolve();

  constructor(options) {
    if (!options || typeof options !== 'object' || typeof options.enabled !== 'function'
      || typeof options.snapshot !== 'function' || typeof options.onFailure !== 'function'
      || (options.writer !== undefined && typeof options.writer !== 'function')) {
      throw new ContractError('tab_persistence_invalid', 'tab persistence requires enabled, snapshot, and failure handlers');
    }
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
    if (!tasks || typeof tasks.add !== 'function' || typeof tasks.delete !== 'function') {
      throw new ContractError('tab_persistence_tasks_invalid', 'tab persistence observation requires a task set');
    }
    const task = this.recover(operation)
      .finally(() => tasks.delete(task));
    tasks.add(task);
  }

  async recover(operation) {
    const pending = operation ?? this.save();
    try { await pending; return true; }
    catch (error) { this.options.onFailure(error); return false; }
  }

  wait() {
    return this.#tail;
  }
}
