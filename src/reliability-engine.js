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

export class ReliabilityEngine {
  constructor(options = {}) {
    this.modelDialects = options.modelDialects ?? new ModelDialectRegistry({
      path: options.modelDialectPath,
      telemetry: options.telemetry,
    });
    this.continuationCompactor = options.continuationCompactor ?? new ContinuationCompactor({
      scheduler: options.scheduler,
      telemetry: options.telemetry,
    });
    this.contextTokenCounter = options.contextTokenCounter ?? null;
    this.contextTokenizerIdentity = options.contextTokenizerIdentity ?? null;
    this.contextTokenizerExact = options.contextTokenizerExact === true;
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
  longHorizonTrigger(records, options = {}) { return longHorizonCompressionTrigger(records, options); }
  compactTranscript(records, maxBytes, options = {}) { return compactTranscript(records, maxBytes, options); }
  createHandoffFact(records) { return createHandoffFact(records); }
  attachTaskCheckpoint(fact, path) { return attachTaskCheckpoint(fact, path); }
  buildColdEvidence(records, activeRecords, query) { return buildColdEvidence(records, activeRecords, query); }
  providerContextLimit(active) { return providerContextLimitDecision(active); }
  reasoningOnly(active) { return reasoningOnlyDecision(active); }
  toolProgressEvidence(items, steeringApplied = []) { return toolProgressEvidence(items, steeringApplied); }
  toolFailureFingerprint(items) { return toolFailureFingerprint(items); }
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
    });
  }
}
