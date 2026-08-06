// SPDX-License-Identifier: Apache-2.0
import { compactTranscript } from './compaction.js';
import { contextBudget } from './context-budget.js';
import { buildReportedContext } from './engine-context-status.js';
import { addHookContexts, hookPayload } from './engine-hooks.js';
import { ContractError } from './ids.js';

export async function prepareEngineContext(engine, records, content, active, force, operations) {
  const routes = engine.router.candidates('primary', { requiredCapabilities: ['tools'] });
  const runtime = await engine.modelRuntime.resolve(engine.router, routes[0], active.controller.signal);
  active.runtimeModel = runtime;
  const planned = contextBudget(engine.config, routes, runtime, active.contextRetryScale);
  recordBudget(engine, runtime, planned, active);
  const hardLimit = planned.hardLimitBytes;
  const thresholdBudget = planned.thresholdBytes;
  const budget = Math.min(thresholdBudget, active.contextRetryBudgetBytes ?? thresholdBudget);
  active.contextLimitBytes = hardLimit;
  if (!force) {
    try {
      return await buildReportedContext(engine, records, content, active.enrichment, active, budget, hardLimit, planned);
    } catch (error) {
      if (error.code !== 'context_too_large') throw error;
    }
  }
  return compactContext(engine, records, content, active, operations, { routes, runtime, planned, budget, hardLimit });
}

async function compactContext(engine, records, content, active, operations, plan) {
  const { routes, runtime, planned, budget, hardLimit } = plan;
  engine.state.transition('compacting_context', { trigger: 'context_preflight', turnId: active.turnId });
  const beforeEstimatedTokens = estimatedTranscriptTokens(records, content);
  await emitCompactionStatus(engine, active, 'started', {
    trigger: active.contextRetryScale < 1 ? 'provider_context_limit' : 'automatic_threshold',
    before_estimated_tokens: beforeEstimatedTokens,
    target_tokens: planned.scaledTokens,
  });
  const lifecycle = engine.lifecycles.start('compaction', active.turnId);
  const pre = await operations.publish('compaction.pre', 'compaction', 'pre', active, null, hookPayload(engine, active));
  await addHookContexts(engine, active, pre);
  await operations.publish('compaction.started', 'compaction', 'active', active);
  try {
    if (active.compactionAttempts >= 4) {
      throw new ContractError('context_compaction_stalled', 'context compaction reached its bounded retry limit');
    }
    const compacted = compactTranscript(records, budget);
    if (active.compactionFingerprints.has(compacted.fact.sourceFingerprint)) {
      throw new ContractError('context_compaction_stalled', 'context compaction made no observable source progress');
    }
    active.compactionAttempts += 1;
    active.compactionFingerprints.add(compacted.fact.sourceFingerprint);
    const fact = await engine.continuationCompactor.refine(
      compacted.fact, engine.router, routes[0], runtime, active.controller.signal,
    );
    await operations.persist('compaction', fact);
    engine.lifecycles.finish(lifecycle.id, 'completed');
    const post = await operations.publish(
      'compaction.terminal', 'compaction', 'terminal', active, 'completed', hookPayload(engine, active),
    );
    await addHookContexts(engine, active, post);
    const context = await buildReportedContext(
      engine, engine.transcript, content, active.enrichment, active, budget, hardLimit, planned,
    );
    await emitCompactionStatus(engine, active, 'completed', {
      trigger: active.contextRetryScale < 1 ? 'provider_context_limit' : 'automatic_threshold',
      before_estimated_tokens: beforeEstimatedTokens,
      after_estimated_tokens: active.contextTokens,
      omitted_records: fact.omitted,
      retained_records: fact.retainedRecords?.length ?? 0,
    });
    return context;
  } catch (error) {
    engine.lifecycles.finish(lifecycle.id, 'failed');
    await operations.publish('compaction.terminal', 'compaction', 'terminal', active, 'failed');
    await emitCompactionStatus(engine, active, 'failed', { reason_code: error.code ?? 'compaction_failed' });
    throw error;
  }
}

function emitCompactionStatus(engine, active, status, detail) {
  if (engine.surface !== 'interactive_tui') return Promise.resolve();
  return engine.output({
    version: '1.0', type: 'context_compaction_status', session_id: engine.sessionId,
    turn_id: active.turnId, status, ...detail,
  });
}

function estimatedTranscriptTokens(records, content) {
  const bytes = Buffer.byteLength(JSON.stringify(records), 'utf8') + Buffer.byteLength(content, 'utf8');
  return Math.ceil(bytes / 3);
}

function recordBudget(engine, runtime, planned, active) {
  engine.telemetry?.record('context.budget', 'measured', {
    provider_profile: runtime.providerId, model: runtime.model,
    source: planned.source, authoritative: runtime.authoritative,
    context_window_tokens: planned.windowTokens,
    effective_input_tokens: planned.effectiveInputTokens,
    compaction_threshold_tokens: planned.thresholdTokens,
    output_reserve_tokens: planned.outputReserveTokens,
    parallel_capacity: planned.parallelCapacity,
    hard_limit_bytes: planned.hardLimitBytes,
  }, { turnId: active.turnId, stepId: active.stepId });
}
