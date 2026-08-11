// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { attachTaskCheckpoint, compactTranscript } from './compaction.js';
import { contextBudget } from './context-budget.js';
import { buildReportedContext } from './engine-context-status.js';
import { addHookContexts, hookPayload } from './engine-hooks.js';
import { ContractError } from './ids.js';
import { pressureTier, projectActiveTurn } from './active-context-pressure.js';
import { longHorizonCompressionTrigger } from './long-horizon-context.js';
import { writeTaskCheckpoint } from './task-checkpoint.js';

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
    const fitted = await fitCompactedContext(engine, records, active, operations, {
      budget, hardLimit, planned, route: routes[0], runtime,
    });
    const { fact, context } = fitted;
    const post = await operations.publish(
      'compaction.terminal', 'compaction', 'terminal', active, 'completed', hookPayload(engine, active),
    );
    await addHookContexts(engine, active, post);
    engine.lifecycles.finish(lifecycle.id, 'completed');
    await emitCompactionStatus(engine, active, 'completed', compactionCompletedDetail(active, fact, beforeEstimatedTokens));
    recordCompactionTelemetry(engine, active, 'succeeded', compactionProjectionDetail(active, fact));
    active.contextCompressionTrigger = null;
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

async function fitCompactedContext(engine, records, active, operations, plan) {
  let budget = plan.budget; let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await createCompactionCandidate(engine, records, active, { ...plan, budget });
    try {
      let fact = candidate;
      let context = await validateCompactionCandidate(engine, fact, active, plan);
      try {
        const checkpointPath = await writeTaskCheckpoint(engine, fact);
        if (checkpointPath) {
          const checkpointFact = attachTaskCheckpoint(fact, checkpointPath);
          context = await validateCompactionCandidate(engine, checkpointFact, active, plan);
          fact = checkpointFact;
        }
      } catch (error) {
        engine.telemetry?.record('context.task_checkpoint', 'failed', {
          reason_code: error.code ?? 'task_checkpoint_write_failed',
        }, { turnId: active.turnId, stepId: active.stepId });
      }
      await commitCompactionCandidate(engine, fact, active, operations);
      return { fact, context };
    } catch (error) {
      if (error.code !== 'context_too_large') throw error;
      lastError = error; budget = Math.max(8_192, Math.floor(budget * 0.6));
    }
  }
  throw lastError;
}

async function createCompactionCandidate(engine, records, active, plan) {
  const source = includeUnprojectedActiveRecords(records, engine.transcript, active.turnId);
  const compacted = compactTranscript(source, plan.budget, {
    activeTurnId: active.turnId, activeStepId: active.stepId,
    protectedActiveSteps: 2, requireProgress: true,
  });
  const repeated = active.lastCompactionSourceFingerprint === compacted.fact.sourceFingerprint
    ? active.compactionNoProgressAttempts + 1 : 0;
  if (repeated >= 2) {
    throw new ContractError('context_compaction_stalled', 'context compaction made no observable source progress');
  }
  return engine.continuationCompactor.refine(
    compacted.fact, engine.router, plan.route, plan.runtime, active.controller.signal,
  );
}

function validateCompactionCandidate(engine, fact, active, plan) {
  return buildReportedContext(
    engine, [...engine.transcript, fact], '', active.enrichment, active,
    plan.budget, plan.hardLimit, plan.planned,
  );
}

async function commitCompactionCandidate(engine, fact, active, operations) {
  await operations.persist('compaction', fact);
  active.compactionNoProgressAttempts = active.lastCompactionSourceFingerprint === fact.sourceFingerprint
    ? active.compactionNoProgressAttempts + 1 : 0;
  active.compactionAttempts += 1;
  active.lastCompactionSourceFingerprint = fact.sourceFingerprint;
  active.compactionFingerprints.add(fact.sourceFingerprint);
  if (fact.continuation?.taskStatePath) engine.telemetry?.record('context.task_checkpoint', 'succeeded', {
    path_attached: true,
  }, { turnId: active.turnId, stepId: active.stepId });
}

function includeUnprojectedActiveRecords(records, transcript, turnId) {
  const source = [...records];
  const identities = new Set(source.map(recordIdentity));
  for (const record of transcript) {
    const identity = recordIdentity(record);
    if ((record.turnId ?? record.turn_id) !== turnId || identities.has(identity)) continue;
    source.push(record);
    identities.add(identity);
  }
  return source;
}

function recordIdentity(record) {
  try {
    return createHash('sha256').update(JSON.stringify({
      type: record.type, role: record.role, turnId: record.turnId ?? record.turn_id,
      stepId: record.stepId ?? record.step_id, providerCallId: record.providerCallId,
      requestId: record.requestId, toolName: record.toolName, status: record.status,
      content: record.content, args: record.args,
    })).digest('hex');
  } catch {
    return `${record.type}:${record.turnId ?? record.turn_id}:${record.stepId ?? record.step_id}:${record.providerCallId ?? ''}`;
  }
}

async function pressureProjection(engine, active, operations, measurement) {
  const horizon = longHorizonCompressionTrigger(measurement.records, {
    activeTurnId: active.turnId, effectiveInputTokens: measurement.effectiveInputTokens,
  });
  if (horizon) {
    active.contextCompressionTrigger = horizon.reason;
    engine.telemetry?.record('context.compression', 'triggered', horizon, {
      turnId: active.turnId, stepId: active.stepId,
    });
    throw new ContractError('context_too_large', `long-horizon compression required: ${horizon.reason}`);
  }
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
    semantic_receipt_records: fact.projection?.semanticReceiptRecords ?? 0,
    hierarchy_chunks: fact.projection?.hierarchyChunks ?? 1,
    task_checkpoint: Boolean(fact.continuation?.taskStatePath),
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
    summary_budget_bytes: fact.projection?.summaryBudgetBytes ?? null,
    hierarchy_chunks: fact.projection?.hierarchyChunks ?? 1,
    task_checkpoint: Boolean(fact.continuation?.taskStatePath),
    source_fingerprint: fact.sourceFingerprint,
  };
}

function compactionTrigger(active) {
  if (active.contextRetryScale < 1) return 'provider_context_limit';
  return active.contextCompressionTrigger ?? 'automatic_threshold';
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
