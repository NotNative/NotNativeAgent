// SPDX-License-Identifier: Apache-2.0
import { compactTranscript } from './compaction.js';
import { ContractError } from './ids.js';

export async function compactEngineConversation(engine) {
  if (engine.state.state !== 'idle') throw new ContractError('compaction_busy', 'wait for the active turn before compacting');
  const compacted = compactTranscript(engine.transcript, engine.config.limits.maxContextBytes);
  const route = engine.router.resolve('primary');
  const signal = new AbortController().signal;
  const runtime = await engine.modelRuntime.resolve(engine.router, route, signal);
  const fact = await engine.continuationCompactor.refine(compacted.fact, engine.router, route, runtime, signal);
  if (engine.store) await engine.store.append('compaction_snapshot', {
    records: engine.transcript, fact,
  });
  engine.transcript.push(fact);
  return Object.freeze({ omitted: fact.omitted, retained: fact.retainedRecords?.length ?? 0, fact });
}

export async function clearEngineConversation(engine) {
  if (engine.state.state !== 'idle') throw new ContractError('clear_busy', 'wait for the active turn before clearing context');
  const removed = engine.transcript.length;
  if (engine.store) await engine.store.append('conversation_cleared', { removed, clearedAt: new Date().toISOString() });
  engine.transcript = [];
  engine.authority.clearConversation();
  return Object.freeze({ removed, cleared: true });
}
