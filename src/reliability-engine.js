// SPDX-License-Identifier: Apache-2.0
import { RecoverySupervisor, recoveryExhaustionDetail, recoveryExhaustionText, recoveryHint } from './reliability/recovery-supervisor.js';
import { evaluateCompletion, partialOutputProgress } from './reliability/completion-supervisor.js';
import { contextPressurePolicy, pressureTier, projectActiveTurn } from './reliability/context-pressure.js';
import { ContinuationCompactor } from './reliability/continuation-compactor.js';
import { ModelDialectRegistry } from './reliability/model-dialects.js';
import { providerContextLimitDecision, reasoningOnlyDecision } from './reliability/provider-recovery.js';
import { toolFailureFingerprint, toolProgressEvidence } from './reliability/tool-progress.js';
import { contextBudget, estimateContextTokens } from './reliability/context-budget.js';
import { longHorizonCompressionTrigger } from './reliability/long-horizon-context.js';
import { attachTaskCheckpoint, compactTranscript, createHandoffFact } from './reliability/compaction.js';
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
  }

  async initialize() { await this.modelDialects.initialize(); }
  async close() { await this.modelDialects.close(); }

  createTurnSupervisor(options = {}) { return new RecoverySupervisor(options); }
  localRetryLimit(active) { return active.recovery.localLimit; }
  providerRetry(active, category, attempt, partial, suggestedDelayMs = null) {
    return active.recovery.providerRetry(category, attempt, partial, suggestedDelayMs);
  }
  noProgress(active, category, evidence = null, detail = {}, options = {}) {
    return active.recovery.noProgress(category, evidence, detail, options);
  }
  continuation(active, category, evidence = null, detail = {}, options = {}) {
    return active.recovery.continuation(category, evidence, detail, options);
  }
  externalEvidence(active, value) { return active.recovery.externalEvidence(value); }
  createToolCallAssembler() { return new ToolCallAssembler(); }
  evaluateCompletion(active, text, work = null) { return evaluateCompletion(active, text, work); }
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
    return contextBudget(config, routes, runtime, retryScale);
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
  assertProviderRequestManifest(request, manifest, route, active) {
    return assertProviderRequestManifest(request, manifest, route, active);
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
  observeProviderUsage(route, usage) {
    const key = routeKey(route);
    const cacheTokens = cacheTokenEvidence(usage);
    if (!key || cacheTokens <= 0) return false;
    if (!this.cacheUsageByRoute.has(key) && this.cacheUsageByRoute.size >= 128) {
      this.cacheUsageByRoute.delete(this.cacheUsageByRoute.keys().next().value);
    }
    this.cacheUsageByRoute.delete(key);
    this.cacheUsageByRoute.set(key, Object.freeze({ cache_read_tokens: cacheTokens }));
    return true;
  }
  cacheUsage(route) { return this.cacheUsageByRoute.get(routeKey(route)) ?? null; }
  longHorizonTrigger(records, options = {}) { return longHorizonCompressionTrigger(records, options); }
  compactTranscript(records, maxBytes, options = {}) { return compactTranscript(records, maxBytes, options); }
  createHandoffFact(records) { return createHandoffFact(records); }
  attachTaskCheckpoint(fact, path) { return attachTaskCheckpoint(fact, path); }
  buildColdEvidence(records, activeRecords, query) { return buildColdEvidence(records, activeRecords, query); }
  providerContextLimit(active) { return providerContextLimitDecision(active); }
  reasoningOnly(active) { return reasoningOnlyDecision(active); }
  toolProgressEvidence(items, steeringApplied = [], options = {}) { return toolProgressEvidence(items, steeringApplied, options); }
  toolFailureFingerprint(items) { return toolFailureFingerprint(items); }
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
