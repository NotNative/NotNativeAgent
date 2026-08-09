// SPDX-License-Identifier: Apache-2.0
import { compactTranscript } from './compaction.js';
import { contextBudget } from './context-budget.js';
import { buildReportedContext } from './engine-context-status.js';
import { addHookContexts, hookPayload } from './engine-hooks.js';
import { ContractError } from './ids.js';
import { pressureTier, projectActiveTurn } from './active-context-pressure.js';

export async function prepareEngineContext(engine, records, content, active, force, operations) {
  const routes = engine.router.candidates('primary', { requiredCapabilities: ['tools'] });
  const runtime = await engine.modelRuntime.resolve(engine.router, routes[0], active.controller.signal);
  active.runtimeModel = runtime;
  const planned = contextBudget(engine.config, routes, runtime, active.contextRetryScale);
  recordBudget(engine, runtime, planned, active);
  const hardLimit = planned.hardLimitBytes;
  const thresholdBudget = planned.thresholdBytes;
  const budget = thresholdBudget;
  active.contextLimitBytes = hardLimit;
  if (!force) {
    try {
      return await buildReportedContext(
        engine, records, content, active.enrichment, active, budget, hardLimit, planned,
        { projectContext: (measurement) => pressureProjection(engine, active, operations, measurement) },
      );
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
  const started = compactionStartedDetail(active, planned, beforeEstimatedTokens);
  await emitCompactionStatus(engine, active, 'started', started);
  recordCompactionTelemetry(engine, active, 'started', started);
  const lifecycle = engine.lifecycles.start('compaction', active.turnId);
  const pre = await operations.publish('compaction.pre', 'compaction', 'pre', active, null, hookPayload(engine, active));
  await addHookContexts(engine, active, pre);
  await operations.publish('compaction.started', 'compaction', 'active', active);
  try {
    const fact = await createCompactionFact(engine, records, active, operations, { budget, route: routes[0], runtime });
    const post = await operations.publish(
      'compaction.terminal', 'compaction', 'terminal', active, 'completed', hookPayload(engine, active),
    );
    await addHookContexts(engine, active, post);
    const context = await buildReportedContext(
      engine, engine.transcript, content, active.enrichment, active, budget, hardLimit, planned,
    );
    engine.lifecycles.finish(lifecycle.id, 'completed');
    await emitCompactionStatus(engine, active, 'completed', compactionCompletedDetail(active, fact, beforeEstimatedTokens));
    recordCompactionTelemetry(engine, active, 'succeeded', compactionProjectionDetail(active, fact));
    return context;
  } catch (error) {
    engine.lifecycles.finish(lifecycle.id, 'failed');
    await operations.publish('compaction.terminal', 'compaction', 'terminal', active, 'failed');
    await emitCompactionStatus(engine, active, 'failed', { reason_code: error.code ?? 'compaction_failed' });
    recordCompactionTelemetry(engine, active, 'failed', {
      trigger: active.contextRetryScale < 1 ? 'provider_context_limit' : 'automatic_threshold',
      reason_code: error.code ?? 'compaction_failed',
    }, error.code ?? 'compaction_failed');
    throw error;
  }
}

async function createCompactionFact(engine, records, active, operations, plan) {
  const compacted = compactTranscript(records, plan.budget, {
    activeTurnId: active.turnId, activeStepId: active.stepId,
    protectedActiveSteps: 2, requireProgress: true,
  });
  if (active.lastCompactionSourceFingerprint === compacted.fact.sourceFingerprint) {
    active.compactionNoProgressAttempts += 1;
  } else {
    active.compactionNoProgressAttempts = 0;
  }
  if (active.compactionNoProgressAttempts >= 2) {
    throw new ContractError('context_compaction_stalled', 'context compaction made no observable source progress');
  }
  active.compactionAttempts += 1;
  active.lastCompactionSourceFingerprint = compacted.fact.sourceFingerprint;
  active.compactionFingerprints.add(compacted.fact.sourceFingerprint);
  const fact = await engine.continuationCompactor.refine(
    compacted.fact, engine.router, plan.route, plan.runtime, active.controller.signal,
  );
  await operations.persist('compaction', fact);
  return fact;
}

async function pressureProjection(engine, active, operations, measurement) {
  const tier = pressureTier(measurement.rawContextTokens, measurement.effectiveInputTokens);
  const ratio = measurement.effectiveInputTokens
    ? measurement.rawContextTokens / measurement.effectiveInputTokens : null;
  active.contextPressureTier = tier;
  const projection = projectActiveTurn(measurement.records, {
    turnId: active.turnId, stepId: active.stepId, tier,
  });
  if (projection.checkpoint && tier !== 'receipts'
    && !active.contextCheckpointFingerprints.has(projection.sourceFingerprint)) {
    await operations.persist('context_checkpoint', projection.checkpoint);
    active.contextCheckpointFingerprints.add(projection.sourceFingerprint);
    await operations.publish(
      'context_checkpoint.terminal', 'context_checkpoint', 'terminal', active, 'completed',
      hookPayload(engine, active, {
        checkpoint_summary: projection.checkpoint.summary,
        checkpoint_tier: tier,
        checkpoint_fingerprint: projection.sourceFingerprint,
      }),
    );
  }
  engine.telemetry?.record('context.pressure', tier === 'none' ? 'measured' : 'projected', {
    tier, ratio, raw_estimated_tokens: measurement.rawContextTokens,
    effective_input_tokens: measurement.effectiveInputTokens,
    cold_records: projection.coldRecords,
    retained_active_steps: projection.retainedActiveSteps,
    source_fingerprint: projection.sourceFingerprint,
  }, { turnId: active.turnId, stepId: active.stepId });
  if (tier === 'compact') {
    throw new ContractError('context_too_large', 'context reached the automatic compaction pressure boundary');
  }
  return projection;
}

function compactionStartedDetail(active, planned, beforeEstimatedTokens) {
  return {
    trigger: compactionTrigger(active), before_estimated_tokens: beforeEstimatedTokens,
    target_tokens: planned.scaledTokens,
  };
}

function compactionCompletedDetail(active, fact, beforeEstimatedTokens) {
  return {
    trigger: compactionTrigger(active), before_estimated_tokens: beforeEstimatedTokens,
    after_estimated_tokens: active.contextTokens, omitted_records: fact.omitted,
    retained_records: fact.retainedRecords?.length ?? 0,
    protected_turns: fact.projection?.protectedTurnCount ?? 0,
    payload_compacted_records: fact.projection?.payloadCompactedRecords ?? 0,
  };
}

function compactionProjectionDetail(active, fact) {
  return {
    trigger: compactionTrigger(active), policy: fact.projection?.policy ?? 'legacy',
    protected_completed_turns: fact.projection?.protectedCompletedTurns ?? 0,
    protected_turn_count: fact.projection?.protectedTurnCount ?? 0,
    protected_record_count: fact.projection?.protectedRecordCount ?? 0,
    payload_compacted_records: fact.projection?.payloadCompactedRecords ?? 0,
    oversized_protected_records: fact.projection?.oversizedProtectedRecords ?? 0,
    superseded_records: fact.projection?.supersededRecords ?? 0,
    original_bytes: fact.projection?.originalBytes ?? null,
    projected_bytes: fact.projection?.projectedBytes ?? null,
    source_fingerprint: fact.sourceFingerprint,
  };
}

function compactionTrigger(active) {
  return active.contextRetryScale < 1 ? 'provider_context_limit' : 'automatic_threshold';
}

function recordCompactionTelemetry(engine, active, status, detail, reasonCode = null) {
  engine.telemetry?.record('context.compaction', status, detail, {
    turnId: active.turnId, stepId: active.stepId, ...(reasonCode ? { reasonCode } : {}),
  });
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
