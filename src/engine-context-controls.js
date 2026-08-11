// SPDX-License-Identifier: Apache-2.0
import { attachTaskCheckpoint, compactTranscript, createHandoffFact } from './compaction.js';
import { ContractError } from './ids.js';
import { writeTaskCheckpoint } from './task-checkpoint.js';

export async function compactEngineConversation(engine) {
  if (engine.state.state !== 'idle') throw new ContractError('compaction_busy', 'wait for the active turn before compacting');
  engine.telemetry?.record('context.compaction', 'started', { trigger: 'operator_command' });
  try {
    const compacted = compactTranscript(engine.transcript, engine.config.limits.maxContextBytes, {
      requireProgress: true,
    });
    const route = engine.router.resolve('primary');
    const signal = new AbortController().signal;
    const runtime = await engine.modelRuntime.resolve(engine.router, route, signal);
    let fact = await engine.continuationCompactor.refine(compacted.fact, engine.router, route, runtime, signal);
    try {
      const checkpointPath = await writeTaskCheckpoint(engine, fact);
      if (checkpointPath) fact = attachTaskCheckpoint(fact, checkpointPath);
    } catch (error) {
      engine.telemetry?.record('context.task_checkpoint', 'failed', {
        reason_code: error.code ?? 'task_checkpoint_write_failed', trigger: 'operator_command',
      });
    }
    if (engine.store) await engine.store.append('compaction_snapshot', {
      records: engine.transcript, fact,
    });
    engine.transcript.push(fact);
    engine.telemetry?.record('context.compaction', 'succeeded', {
      trigger: 'operator_command', policy: fact.projection?.policy ?? 'legacy',
      protected_completed_turns: fact.projection?.protectedCompletedTurns ?? 0,
      protected_turn_count: fact.projection?.protectedTurnCount ?? 0,
      protected_record_count: fact.projection?.protectedRecordCount ?? 0,
      payload_compacted_records: fact.projection?.payloadCompactedRecords ?? 0,
      oversized_protected_records: fact.projection?.oversizedProtectedRecords ?? 0,
      superseded_records: fact.projection?.supersededRecords ?? 0,
      original_bytes: fact.projection?.originalBytes ?? null,
      projected_bytes: fact.projection?.projectedBytes ?? null,
      summary_budget_bytes: fact.projection?.summaryBudgetBytes ?? null,
      hierarchy_chunks: fact.projection?.hierarchyChunks ?? 1,
      task_checkpoint: Boolean(fact.continuation?.taskStatePath),
      source_fingerprint: fact.sourceFingerprint,
    });
    return Object.freeze({
      omitted: fact.omitted,
      retained: fact.retainedRecords?.length ?? 0,
      reduced: fact.projection?.payloadCompactedRecords ?? 0,
      beforeBytes: fact.projection?.originalBytes ?? null,
      afterBytes: fact.projection?.projectedBytes ?? null,
      fact,
    });
  } catch (error) {
    engine.telemetry?.record('context.compaction', 'failed', {
      trigger: 'operator_command', reason_code: error.code ?? 'compaction_failed',
    }, { reasonCode: error.code ?? 'compaction_failed' });
    throw error;
  }
}

export async function handoffEngineConversation(engine) {
  if (engine.state.state !== 'idle') throw new ContractError('handoff_busy', 'wait for the active turn before creating a handoff');
  engine.telemetry?.record('context.handoff', 'started', { trigger: 'operator_command' });
  try {
    const base = createHandoffFact(engine.transcript);
    const route = engine.router.resolve('primary');
    const signal = new AbortController().signal;
    const runtime = await engine.modelRuntime.resolve(engine.router, route, signal);
    const fact = await engine.continuationCompactor.handoff(base, engine.router, route, runtime, signal);
    if (engine.store) await engine.store.append('compaction_snapshot', { records: engine.transcript, fact });
    engine.transcript.push(fact);
    engine.telemetry?.record('context.handoff', 'succeeded', {
      trigger: 'operator_command', omitted_records: fact.omitted,
      original_bytes: fact.projection.originalBytes, projected_bytes: fact.projection.projectedBytes,
      source_fingerprint: fact.sourceFingerprint,
    });
    return Object.freeze({
      omitted: fact.omitted, retained: 0, reduced: 0,
      beforeBytes: fact.projection.originalBytes, afterBytes: fact.projection.projectedBytes, fact,
    });
  } catch (error) {
    engine.telemetry?.record('context.handoff', 'failed', {
      trigger: 'operator_command', reason_code: error.code ?? 'handoff_failed',
    }, { reasonCode: error.code ?? 'handoff_failed' });
    throw error;
  }
}

export async function clearEngineConversation(engine) {
  if (engine.state.state !== 'idle') throw new ContractError('clear_busy', 'wait for the active turn before clearing context');
  const removed = engine.transcript.length;
  if (engine.store) await engine.store.append('conversation_cleared', { removed, clearedAt: new Date().toISOString() });
  await engine.work?.clear();
  engine.transcript = [];
  engine.authority.clearConversation();
  return Object.freeze({ removed, cleared: true });
}
