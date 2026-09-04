// SPDX-License-Identifier: Apache-2.0
import { RecoverySupervisor, recoveryExhaustionDetail, recoveryExhaustionText, recoveryHint } from './reliability/recovery-supervisor.js';
import { completionAdvisories, evaluateCompletion, partialOutputProgress } from './reliability/completion-supervisor.js';
import { contextPressurePolicy, pressureTier, projectActiveTurn } from './reliability/context-pressure.js';
import { ContinuationCompactor } from './reliability/continuation-compactor.js';
import { ModelDialectRegistry } from './reliability/model-dialects.js';
import { providerContextLimitDecision, reasoningOnlyDecision } from './reliability/provider-recovery.js';
import {
  toolFailureFingerprint, toolProgressEvidence, toolRequestFingerprint, toolRequestFingerprints,
} from './reliability/tool-progress.js';
import { contextBudget, estimateContextTokens } from './reliability/context-budget.js';
import { longHorizonCompressionTrigger } from './reliability/long-horizon-context.js';
import { compactTranscript, createHandoffFact } from './reliability/compaction.js';
import { attachTaskCheckpoint } from './reliability/continuation-artifact.js';
import { ToolCallAssembler } from './reliability/tool-call-assembler.js';
import { buildColdEvidence } from './reliability/cold-context.js';
import {
  hostEnvironment, hostEnvironmentInstruction, normalizeShellExecutionError, shellReliabilitySignals,
  shellToolGuidance, unavailableShellMessage,
} from './reliability/host-environment.js';
import { ProcessIdentity } from './reliability/process-identity.js';
import { inlineInterpreterGuidance, inlineInterpreterInvocation } from './reliability/command-shaping.js';
import {
  compareCompressionOutcomes, contextCompressionPolicy, measureContextCompression,
} from './reliability/context-compression.js';
import { interruptedToolRepairs } from './reliability/interrupted-tools.js';
import { assertProviderRequestManifest, providerRequestManifest } from './reliability/request-invariant.js';
import {
  aggregateTokenReceipts, assertProviderEnvelopeFits, combineTokenAccounting,
  createProviderTokenReceipt, measureProviderEnvelope,
} from './reliability/token-accounting.js';
import {
  appendReasoningChunk, boundedReasoningContinuations, captureReasoningContinuation,
} from './reliability/reasoning-continuity.js';
import { trustedToolHandoff } from './reliability/trusted-tool-handoff.js';

export class ReliabilityEngine {
  constructor(options = {}) {
    this.modelDialects = options.modelDialects ?? new ModelDialectRegistry({
      path: options.modelDialectPath,
      telemetry: options.telemetry,
    });
    this.continuationCompactor = options.continuationCompactor ?? new ContinuationCompactor({
      scheduler: options.scheduler,
      telemetry: options.telemetry,
      recordTokenReceipt: options.tokenReceiptRecorder,
    });
    this.contextTokenCounter = options.contextTokenCounter ?? null;
    this.contextTokenizerIdentity = options.contextTokenizerIdentity ?? null;
    this.contextTokenizerExact = options.contextTokenizerExact === true;
    this.cacheUsageByRoute = new Map();
    this.contextEstimateScaleByRoute = new Map();
  }

  async initialize() { await this.modelDialects.initialize(); }
  async close() { await this.modelDialects.close(); }

  createTurnSupervisor(options = {}) { return new RecoverySupervisor(options); }
  localRetryLimit(active) { return active.recovery.localLimit; }
  providerRetry(active, category, attempt, partial, suggestedDelayMs = null) {
    return active.recovery.providerRetry(category, attempt, partial, suggestedDelayMs);
  }
  providerUnusableCompletion(active, detail = {}, options = {}) {
    return active.recovery.providerUnusableCompletion(detail, options);
  }
  providerOutputObserved(active) { return active.recovery.providerOutputObserved(); }
  noProgress(active, category, evidence = null, detail = {}, options = {}) {
    return active.recovery.noProgress(category, evidence, detail, options);
  }
  continuation(active, category, evidence = null, detail = {}, options = {}) {
    return active.recovery.continuation(category, evidence, detail, options);
  }
  behavioralCheckpoint(active, category, action, count, detail = {}) {
    return active.recovery.behavioralCheckpoint(category, action, count, detail);
  }
  externalEvidence(active, value) { return active.recovery.externalEvidence(value); }
  createToolCallAssembler() { return new ToolCallAssembler(); }
  evaluateCompletion(active, text, work = null) { return evaluateCompletion(active, text, work); }
  completionAdvisories(text) { return completionAdvisories(text); }
  partialOutputProgress(text) { return partialOutputProgress(text); }
  exhaustionDetail(supervisor, transcript, reasonCodes, result) {
    return recoveryExhaustionDetail(supervisor, transcript, reasonCodes, result);
  }
  exhaustionText(detail, options = {}) { return recoveryExhaustionText(detail, options); }
  hint(action) { return recoveryHint(action); }

  contextPolicy(...thresholds) { return contextPressurePolicy(...thresholds); }
  pressureTier(estimatedTokens, effectiveInputTokens, policy) {
    return pressureTier(estimatedTokens, effectiveInputTokens, policy);
  }
  projectActiveTurn(records, options) { return projectActiveTurn(records, options); }
  planContextBudget(config, routes, runtime, retryScale = 1) {
    const estimateScale = routes.reduce(
      (maximum, route) => Math.max(maximum, this.contextEstimateScale(route)), 1,
    );
    return contextBudget(config, routes, runtime, retryScale, estimateScale);
  }
  estimateContextTokens(context) { return estimateContextTokens(context); }
  contextCompressionPolicy(record, options = {}) { return contextCompressionPolicy(record, options); }
  measureContextCompression(before, after, options = {}) {
    return measureContextCompression(before, after, {
      tokenCounter: this.contextTokenCounter,
      tokenizerIdentity: this.contextTokenizerIdentity,
      tokenizerExact: this.contextTokenizerExact,
      ...options,
    });
  }
  compareCompressionOutcomes(baseline, compressed) { return compareCompressionOutcomes(baseline, compressed); }
  interruptedToolRepairs(records, interruptedTurnIds = []) {
    return interruptedToolRepairs(records, interruptedTurnIds);
  }
  providerEnvelope(request, context, options = {}) { return measureProviderEnvelope(request, context, options); }
  assertProviderEnvelopeFits(envelope, budget) { return assertProviderEnvelopeFits(envelope, budget); }
  providerRequestManifest(request, context, route, active, options = {}) {
    const envelope = measureProviderEnvelope(request, context, {
      outputReserveTokens: options.outputReserveTokens ?? active?.contextBudget?.outputReserveTokens,
    });
    return providerRequestManifest(request, context, route, active, envelope);
  }
  assertProviderRequestManifest(request, manifest, route, active, context) {
    return assertProviderRequestManifest(request, manifest, route, active, context);
  }
  providerTokenReceipt(manifest, active, detail = {}) {
    return createProviderTokenReceipt(manifest, active, detail);
  }
  aggregateTokenReceipts(receipts) { return aggregateTokenReceipts(receipts); }
  combineTokenAccounting(summaries) { return combineTokenAccounting(summaries); }
  appendReasoningChunk(current, chunk) { return appendReasoningChunk(current, chunk); }
  captureReasoningContinuation(active, calls) { return captureReasoningContinuation(active, calls); }
  boundedReasoningContinuations(entries, maxContextBytes) {
    return boundedReasoningContinuations(entries, maxContextBytes);
  }
  observeProviderUsage(route, usage, manifest = null) {
    const key = routeKey(route);
    const cacheTokens = cacheTokenEvidence(usage);
    if (!key) return false;
    let observed = false;
    if (cacheTokens > 0) {
      retainBounded(this.cacheUsageByRoute, key, Object.freeze({ cache_read_tokens: cacheTokens }));
      observed = true;
    }
    const promptTokens = promptTokenEvidence(usage);
    const estimatedTokens = manifest?.envelope?.estimated_input_tokens;
    if (promptTokens > 0 && Number.isSafeInteger(estimatedTokens) && estimatedTokens > 0) {
      // Why: provider-reported prompt usage is the only model-specific tokenizer
      // evidence available to a provider-agnostic harness. It may tighten the
      // conservative estimate, but never widen a previously safe budget.
      const scale = Math.max(1, Math.min(8, promptTokens / estimatedTokens));
      const learned = Math.max(this.contextEstimateScaleByRoute.get(key) ?? 1, scale);
      retainBounded(this.contextEstimateScaleByRoute, key, learned);
      observed = true;
    }
    return observed;
  }
  cacheUsage(route) { return this.cacheUsageByRoute.get(routeKey(route)) ?? null; }
  contextEstimateScale(route) { return this.contextEstimateScaleByRoute.get(routeKey(route)) ?? 1; }
  longHorizonTrigger(records, options = {}) { return longHorizonCompressionTrigger(records, options); }
  compactTranscript(records, maxBytes, options = {}) { return compactTranscript(records, maxBytes, options); }
  createHandoffFact(records) { return createHandoffFact(records); }
  attachTaskCheckpoint(fact, path) { return attachTaskCheckpoint(fact, path); }
  buildColdEvidence(records, activeRecords, query) { return buildColdEvidence(records, activeRecords, query); }
  providerContextLimit(active) { return providerContextLimitDecision(active); }
  reasoningOnly(active) { return reasoningOnlyDecision(active); }
  toolProgressEvidence(items, steeringApplied = [], options = {}) { return toolProgressEvidence(items, steeringApplied, options); }
  toolFailureFingerprint(items) { return toolFailureFingerprint(items); }
  toolRequestFingerprint(toolName, args) { return toolRequestFingerprint(toolName, args); }
  toolRequestFingerprints(items) { return toolRequestFingerprints(items); }
  trustedToolHandoff(items) { return trustedToolHandoff(items); }
  hostEnvironment(platform) { return hostEnvironment(platform); }
  hostEnvironmentInstruction(platform) { return hostEnvironmentInstruction(platform); }
  shellToolGuidance(platform) { return shellToolGuidance(platform); }
  unavailableShellMessage(shell, platform) { return unavailableShellMessage(shell, platform); }
  normalizeShellExecutionError(error, shell, platform) { return normalizeShellExecutionError(error, shell, platform); }
  shellReliabilitySignals(script) { return shellReliabilitySignals(script); }
  createProcessIdentity(options = {}) { return new ProcessIdentity(options); }
  inlineInterpreterGuidance() { return inlineInterpreterGuidance(); }
  inlineInterpreterInvocation(executable, args) { return inlineInterpreterInvocation(executable, args); }

  refineContinuation(...args) { return this.continuationCompactor.refine(...args); }
  createHandoff(...args) { return this.continuationCompactor.handoff(...args); }

  instructions(route) { return this.modelDialects.instructions(route); }
  observe(route, outcome) { return this.modelDialects.observe(route, outcome); }
  observeToolContracts(route, items = [], priorConstraints = [], versionFor = () => null) {
    const schemaFailures = new Set(['tool_schema_invalid', 'tool_arguments_malformed', 'tool_arguments_truncated']);
    for (const item of items) {
      const tool = item?.result?.tool_name ?? item?.call?.name;
      const version = versionFor(tool);
      if (typeof tool !== 'string' || !Number.isSafeInteger(version)) continue;
      const reason = item?.result?.reason_code;
      if (item?.result?.status === 'invalid_request' && schemaFailures.has(reason)) {
        this.modelDialects.observeToolContract(route, {
          status: 'failed', tool, version, reason_code: reason,
        });
      }
      if (item?.result?.status === 'succeeded') {
        for (const constraint of priorConstraints.filter((entry) => entry.kind === 'schema_repair' && entry.tool === tool)) {
          this.modelDialects.observeToolContract(route, {
            status: 'repaired', tool, version, reason_code: constraint.reason_code,
          });
        }
      }
    }
  }
  modelSnapshot(route) { return this.modelDialects.snapshot(route); }

  health() {
    return Object.freeze({
      status: 'ready',
      recovery: 'bounded',
      completion_supervision: true,
      context_fitness: true,
      context_compression_policy: true,
      context_compression_measurement: true,
      continuation_compaction: true,
      model_observation: true,
      host_command_shaping: true,
      process_identity: true,
      command_shaping: true,
      provider_request_reconstruction: true,
      provider_envelope_accounting: true,
      durable_token_receipts: true,
      ephemeral_reasoning_continuity: true,
      trusted_tool_handoffs: true,
    });
  }
}

function routeKey(route) {
  const provider = route?.profile?.id ?? route?.providerProfile ?? route?.providerId;
  const model = route?.model;
  return typeof provider === 'string' && provider && typeof model === 'string' && model
    ? `${provider}\0${model}` : null;
}

function cacheTokenEvidence(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return ['cache_read_tokens', 'cacheReadTokens', 'prompt_cache_hit_tokens', 'cached_tokens']
    .reduce((maximum, key) => Number.isSafeInteger(usage[key]) ? Math.max(maximum, usage[key]) : maximum, 0);
}

function promptTokenEvidence(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return ['prompt_tokens', 'input_tokens', 'inputTokens']
    .reduce((maximum, key) => Number.isSafeInteger(usage[key]) ? Math.max(maximum, usage[key]) : maximum, 0);
}

function retainBounded(map, key, value) {
  if (!map.has(key) && map.size >= 128) map.delete(map.keys().next().value);
  map.delete(key);
  map.set(key, value);
}
