// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { drainActivityWrites } from './nnd-activity-snapshot.js';
import { settleNndTimelinesForShutdown } from './nnd-timeline-mutation.js';

/** A shutdown closes admission synchronously, then waits for admitted work. */
export class NndHostLifecycle {
  #stopping = false;
  #shutdown = null;
  #pending = new Set();

  get stopping() { return this.#stopping; }

  assertOpen(code = 'nnd_session_unavailable', message = 'NND session host is shutting down') {
    if (this.#stopping) throw new ContractError(code, message);
  }

  track(promise) {
    this.#pending.add(promise);
    // A rejected operation still settles its lifecycle reservation. The
    // returned promise retains the rejection for its actual caller.
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }

  async settle(waitMs = 30_000) {
    const pending = [...this.#pending];
    if (pending.length === 0) return;
    let timer;
    try {
      await Promise.race([Promise.allSettled(pending), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ContractError('nnd_shutdown_busy',
          'NND session operations did not settle before shutdown')), waitMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  shutdown(work) {
    if (this.#shutdown) return this.#shutdown;
    this.#stopping = true;
    const pending = Promise.resolve().then(work);
    this.#shutdown = pending;
    void pending.then(undefined, () => {
      // A failed shutdown may be retried after a stalled operation settles,
      // but no new work is admitted after teardown was requested.
      if (this.#shutdown === pending) this.#shutdown = null;
    });
    return pending;
  }
}

export async function shutdownNndContext(context, requestId) {
  if (context.engineShutdownComplete) return;
  await context.engine.shutdown({ version: '1.0', type: 'shutdown', request_id: requestId });
  context.engineShutdownComplete = true;
}

export async function shutdownNndHost({ lifecycle, contexts, childSnapshotStore, catalogWrites, uploads }) {
  // The first pass blocks timeline operations in existing contexts. A create
  // may still be finishing; read the map again after every admitted operation.
  await settleNndTimelinesForShutdown(contexts());
  await lifecycle.settle();
  const finalContexts = contexts();
  await settleNndTimelinesForShutdown(finalContexts);
  const settled = await Promise.allSettled(finalContexts.map((context) => shutdownNndContext(context, newId('nnd_shutdown'))));
  await Promise.all(finalContexts.map((context) => drainActivityWrites(context)));
  await childSnapshotStore.drain();
  await catalogWrites().catch(() => undefined);
  uploads.clear();
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}
