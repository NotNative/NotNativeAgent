// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

/** Reserve a settled session timeline before its first asynchronous journal read. */
export function beginNndTimelineMutation(context, kind) {
  if (!context.engine.store) throw new ContractError(`nnd_${kind}_unavailable`, `NND ${kind} requires a durable session journal`);
  if (context.timelineMutation || context.timelineShutdown || context.closing || context.liveTurn
    || context.engine.active && !context.engine.active.finalized
    || context.engine.state?.state && context.engine.state.state !== 'idle') {
    throw new ContractError(`nnd_${kind}_busy`, 'NND session is busy');
  }
  context.timelineMutation = new Promise((resolve) => { context.releaseTimelineMutation = resolve; });
  return context.engine.store;
}

export function endNndTimelineMutation(context) {
  const release = context.releaseTimelineMutation;
  context.timelineMutation = false;
  context.releaseTimelineMutation = null;
  release();
}

export async function settleNndTimelinesForShutdown(contexts, waitMs = 30_000) {
  for (const context of contexts) context.timelineShutdown = true;
  const pending = contexts.map((context) => context.timelineMutation).filter(Boolean);
  if (pending.length === 0) return;
  let timer;
  try {
    await Promise.race([Promise.all(pending), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ContractError('nnd_revert_busy',
        'NND timeline did not settle before shutdown')), waitMs);
    })]);
  } catch (error) {
    for (const context of contexts) context.closing = true;
    throw error;
  } finally { clearTimeout(timer); }
}
