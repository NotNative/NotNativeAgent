// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { buildReportedContext } from './context-status.js';
import { buildContext } from '../context.js';
import { providerRequest } from './runtime-helpers.js';
import { addHookContexts, hookPayload } from './hooks.js';
import { ContractError } from '../ids.js';
import { writeTaskCheckpoint } from '../task-checkpoint.js';
import { toolLifecycleStatus, toolReviewOutcome } from '../tools/tool-result-contract.js';

const MIN_COMPACTION_BUDGET_BYTES = 8_192;
const COMPACTION_REDUCTION_FACTOR = 0.6;
const ESTIMATED_BYTES_PER_TOKEN = 3;

export async function prepareEngineContext(engine, records, content, active, force, operations) {
  const routes = engine.router.candidates('primary', { requiredCapabilities: ['tools'] });
  if (routes.length === 0) throw new ContractError('provider_route_missing', 'no Primary provider route can satisfy the required capabilities');
  const runtime = await engine.modelRuntime.resolve(engine.router, routes[0], active.controller.signal);
  active.runtimeModel = runtime;
  const planned = engine.reliability.planContextBudget(engine.config, routes, runtime, active.contextRetryScale);
  active.contextBudget = planned;
  recordBudget(engine, runtime, planned, active);
  const hardLimit = planned.hardLimitBytes;
  const thresholdBudget = planned.thresholdBytes;
  const budget = thresholdBudget;
  active.contextLimitBytes = hardLimit;
  if (!force) {
    try {
      const context = await buildReportedContext(
        engine, records, content, active.enrichment, active, budget, hardLimit, planned,
        { projectContext: (measurement) => pressureProjection(engine, active, operations, measurement) },
      );
      assertCompleteEnvelope(engine, routes[0], context, planned, active);
      return context;
    } catch (error) {
      if (error.code !== 'context_too_large') throw error;
    }
  }
  const rawContext = buildContext(
    engine.config, records, content,
    active.contextMeasurementEnrichment ?? active.enrichment,
    Number.MAX_SAFE_INTEGER,
  );
  const cacheAlignedRequest = providerRequest(engine, routes[0], rawContext, {
    outputReserveTokens: planned.outputReserveTokens,
    conversationIntent: active.conversationIntent,
    approvedProposal: active.approvedProposal,
  });
  return compactContext(engine, records, content, active, operations, {
    routes, runtime, planned, budget, hardLimit, cacheAlignedRequest,
  });
}

async function compactContext(engine, records, content, active, operations, plan) {
  const { routes, runtime, planned, hardLimit } = plan;
  engine.state.transition('compacting_context', { trigger: 'context_preflight', turnId: active.turnId });
  const beforeEstimatedTokens = estimatedTranscriptTokens(records, content);
  const targetTokens = desiredCompactionTarget(planned, beforeEstimatedTokens);
  const budget = Math.min(plan.budget, Math.max(MIN_COMPACTION_BUDGET_BYTES, targetTokens * ESTIMATED_BYTES_PER_TOKEN));
  const started = compactionStartedDetail(active, planned, beforeEstimatedTokens, targetTokens);
  await emitCompactionStatus(engine, active, 'started', started);
  recordCompactionTelemetry(engine, active, 'started', started);
  const lifecycle = engine.lifecycles.start('compaction', active.turnId);
  const pre = await operations.publish('compaction.pre', 'compaction', 'pre', active, null, hookPayload(engine, active));
  await addHookContexts(engine, active, pre);
  await operations.publish('compaction.started', 'compaction', 'active', active);
  try {
    const fitted = await fitCompactedContext(engine, records, active, operations, {
      budget, validationBudget: plan.budget, hardLimit, planned, route: routes[0], runtime,
      cacheAlignedRequest: plan.cacheAlignedRequest,
    });
    const { fact, context } = fitted;
    const post = await operations.publish(
      'compaction.terminal', 'compaction', 'terminal', active, 'completed', hookPayload(engine, active),
    );
    await addHookContexts(engine, active, post);
    engine.lifecycles.finish(lifecycle.id, 'completed');
    await emitCompactionStatus(engine, active, 'completed', compactionCompletedDetail(active, fact, beforeEstimatedTokens));
    recordCompactionTelemetry(engine, active, 'succeeded', compactionProjectionDetail(active, fact));
    recordCompressionEfficacy(engine, active, records, [
      { type: 'message', role: 'system', content: fact.summary ?? '' },
      ...(fact.retainedRecords ?? []),
    ], [
      { name: 'content_identity_dedup_v1', class: 'recoverable', records: fact.projection?.duplicateResultRecords, bytesSaved: fact.projection?.duplicateResultBytesSaved },
      { name: 'same_target_supersession_v1', class: 'recoverable', records: fact.projection?.supersededRecords },
      { name: 'ledger_backed_receipt_v1', class: 'recoverable', records: fact.projection?.semanticReceiptRecords },
      { name: 'validated_continuation_v1', class: 'semantic', records: 1 },
    ], 'full_compaction');
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
          const checkpointFact = engine.reliability.attachTaskCheckpoint(fact, checkpointPath);
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
      lastError = error;
      budget = Math.max(MIN_COMPACTION_BUDGET_BYTES, Math.floor(budget * COMPACTION_REDUCTION_FACTOR));
    }
  }
  throw lastError;
}

async function createCompactionCandidate(engine, records, active, plan) {
  const source = includeUnprojectedActiveRecords(records, engine.transcript, active.turnId);
  const compacted = engine.reliability.compactTranscript(source, plan.budget, {
    activeTurnId: active.turnId, activeStepId: active.stepId,
    protectedActiveSteps: 2, requireProgress: true,
  });
  const repeated = active.lastCompactionSourceFingerprint === compacted.fact.sourceFingerprint
    ? active.compactionNoProgressAttempts + 1 : 0;
  if (repeated >= 2) {
    throw new ContractError('context_compaction_stalled', 'context compaction made no observable source progress');
  }
  return engine.reliability.refineContinuation(
    compacted.fact, engine.router, plan.route, plan.runtime, active.controller.signal, {
      cacheAlignedRequest: plan.cacheAlignedRequest,
      cacheUsage: engine.reliability.cacheUsage(plan.route),
      allowCacheAligned: active.contextRetryScale >= 1,
    },
  );
}

function validateCompactionCandidate(engine, fact, active, plan) {
  return buildReportedContext(
    engine, [...engine.transcript, fact], '', active.enrichment, active,
    plan.validationBudget, plan.hardLimit, plan.planned,
  ).then((context) => {
    assertCompleteEnvelope(engine, plan.route, context, plan.planned, active);
    return context;
  });
}

function assertCompleteEnvelope(engine, route, context, budget, active) {
  const request = providerRequest(engine, route, context, {
    outputReserveTokens: budget?.outputReserveTokens,
    conversationIntent: active.conversationIntent,
    approvedProposal: active.approvedProposal,
  });
  const envelope = engine.reliability.providerEnvelope(request, context, {
    outputReserveTokens: budget?.outputReserveTokens,
  });
  engine.reliability.assertProviderEnvelopeFits(envelope, budget);
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
      requestId: record.requestId, toolName: record.toolName,
      toolLifecycleStatus: toolLifecycleStatus(record), reviewOutcome: toolReviewOutcome(record),
      content: record.content, args: record.args,
    })).digest('hex');
  } catch {
    return `${record.type}:${record.turnId ?? record.turn_id}:${record.stepId ?? record.step_id}:${record.providerCallId ?? ''}`;
  }
}

async function pressureProjection(engine, active, operations, measurement) {
  const ratio = measurement.effectiveInputTokens
    ? measurement.rawContextTokens / measurement.effectiveInputTokens : null;
  const policy = engine.reliability.contextPolicy(
    engine.config.limits.contextCompressionThreshold,
    engine.config.limits.contextCompressionLevel2Threshold,
    engine.config.limits.contextCompressionLevel3Threshold,
    engine.config.limits.contextCompactionThreshold,
  );
  const horizon = engine.reliability.longHorizonTrigger(measurement.records, {
    activeTurnId: active.turnId, effectiveInputTokens: measurement.effectiveInputTokens,
  });
  const tier = engine.reliability.pressureTier(measurement.rawContextTokens, measurement.effectiveInputTokens, policy);
  active.contextPressureTier = tier;
  if (horizon && tier !== 'none') {
    engine.telemetry?.record('context.compression', tier === 'compact' ? 'escalated' : 'observed', {
      ...horizon, tier, ratio,
    }, { turnId: active.turnId, stepId: active.stepId });
  }
  const projection = engine.reliability.projectActiveTurn(measurement.records, {
    turnId: active.turnId, stepId: active.stepId, tier,
  });
  if (tier !== 'none') {
    recordCompressionEfficacy(engine, active, measurement.records, projection.records, [
      { name: 'content_identity_dedup_v1', class: 'recoverable', records: projection.duplicateResultRecords, bytesSaved: projection.duplicateResultBytesSaved },
      { name: `active_pressure_${tier}_v1`, class: 'recoverable', records: projection.coldRecords },
    ], `active_pressure_${tier}`);
  }
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
    duplicate_result_records: projection.duplicateResultRecords,
    duplicate_result_bytes_saved: projection.duplicateResultBytesSaved,
    source_fingerprint: projection.sourceFingerprint,
  }, { turnId: active.turnId, stepId: active.stepId });
  if (tier === 'compact') {
    active.contextCompressionTrigger = horizon?.reason ?? null;
    throw new ContractError('context_too_large', 'context reached the automatic compaction pressure boundary');
  }
  return projection;
}

function compactionStartedDetail(active, planned, beforeEstimatedTokens, targetTokens) {
  return {
    trigger: compactionTrigger(active), before_estimated_tokens: beforeEstimatedTokens,
    target_tokens: targetTokens, admissible_ceiling_tokens: planned.scaledTokens,
  };
}

function desiredCompactionTarget(planned, beforeEstimatedTokens) {
  const proportional = Math.max(1, Math.floor(beforeEstimatedTokens * 0.75));
  const configured = planned.compressionThresholdTokens ?? proportional;
  return Math.max(1, Math.min(beforeEstimatedTokens - 1, proportional, configured));
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
    duplicate_result_records: fact.projection?.duplicateResultRecords ?? 0,
    duplicate_result_bytes_saved: fact.projection?.duplicateResultBytesSaved ?? 0,
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

function recordCompressionEfficacy(engine, active, before, after, reducers, trigger) {
  const measurement = engine.reliability.measureContextCompression(before, after, { reducers });
  engine.telemetry?.record('context.compression_efficacy', 'measured', {
    trigger,
    before_bytes: measurement.before_bytes,
    after_bytes: measurement.after_bytes,
    bytes_saved: measurement.bytes_saved,
    byte_reduction_ratio: measurement.byte_reduction_ratio,
    before_tokens: measurement.before_tokens,
    after_tokens: measurement.after_tokens,
    tokens_saved: measurement.tokens_saved,
    token_reduction_ratio: measurement.token_reduction_ratio,
    net_tokens_saved: measurement.net_tokens_saved,
    tokenizer_identity: measurement.tokenizer.identity,
    tokenizer_requested_identity: measurement.tokenizer.requested_identity,
    tokenizer_exact: measurement.tokenizer.exact,
    tokenizer_degraded: measurement.tokenizer.degraded,
    reducers: measurement.reducers,
    source_fingerprint: measurement.source_fingerprint,
    projection_fingerprint: measurement.projection_fingerprint,
  }, { turnId: active.turnId, stepId: active.stepId });
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
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);
}

function recordBudget(engine, runtime, planned, active) {
  engine.telemetry?.record('context.budget', 'measured', {
    provider_profile: runtime.providerId, model: runtime.model,
    source: planned.source, authoritative: runtime.authoritative,
    context_window_tokens: planned.windowTokens,
    effective_input_tokens: planned.effectiveInputTokens,
    compression_threshold_tokens: planned.compressionThresholdTokens,
    compaction_threshold_tokens: planned.thresholdTokens,
    output_reserve_tokens: planned.outputReserveTokens,
    parallel_capacity: planned.parallelCapacity,
    hard_limit_bytes: planned.hardLimitBytes,
  }, { turnId: active.turnId, stepId: active.stepId });
}
