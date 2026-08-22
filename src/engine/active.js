// SPDX-License-Identifier: Apache-2.0
import { RecoverySupervisor } from '../reliability/recovery-supervisor.js';
import { ToolCallAssembler } from '../reliability/tool-call-assembler.js';

const ENGINE_ORIGIN = 'engine';

export function createActiveTurn(turnId, requestId, recoveryOptions = {}, reliability = null) {
  const deferred = createDeferred();
  return {
    // Lifecycle and cancellation ownership.
    turnId, requestId, stepId: null, attemptId: null, authority: null,
    controller: new AbortController(), cancelled: false, finalized: false,
    text: '', stepText: '', committedStepText: null, finalText: '', usage: null, finishReason: null, reasoningBytes: 0,
    stepReasoningBytes: 0, stepReasoningText: '', stepReasoningReplayable: false,
    attemptReasoningText: '', attemptReasoningReplayable: false, attemptReasoningOverflow: false,
    attemptOutputLimitTokens: null,
    reasoningContinuations: [],
    reasoningFallbackPending: false, reasoningFallbackUsed: false,
    startedAt: Date.now(), toolCalls: 0,
    providerTerminal: false,
    toolAssemblerFactory: () => reliability?.createToolCallAssembler?.() ?? new ToolCallAssembler(),
    toolAssembler: reliability?.createToolCallAssembler?.() ?? new ToolCallAssembler(),
    deltaSequence: 1, origin: ENGINE_ORIGIN, completion: deferred.promise,
    resolveCompletion: deferred.resolve,
    recovery: reliability?.createTurnSupervisor?.(recoveryOptions) ?? new RecoverySupervisor(recoveryOptions),
    enrichment: { memory: [], attachments: [], hooks: [], skills: [], projectIntake: null }, admission: null,
    prompt: '', conversationIntent: [], modelName: '', unresolvedToolFailures: [], toolConstraints: [], contextRetryScale: 1,
    contextBytes: 0, contextTokens: 0,
    rawContextBytes: 0, rawContextTokens: 0, contextPressureTier: 'none',
    contextLimitTokens: null, contextMeasurementEnrichment: null,
    contextBudget: null, tokenReceipts: [], tokenAccounting: null, delegatedTokenAccounting: null,
    reasoningHeadroomRetryUsed: false,
    compactionAttempts: 0, compactionNoProgressAttempts: 0,
    lastCompactionSourceFingerprint: null, compactionFingerprints: new Set(),
    contextCheckpointFingerprints: new Set(),
    contextCompressionTrigger: null,
  };
}

export function admissionFromRetry(item) {
  const admitted = Boolean(item.admittedAt);
  return Object.freeze({
    admitted: Object.freeze(admitted ? [item] : []),
    failures: Object.freeze(admitted ? [] : [item]),
  });
}

function createDeferred() {
  let resolve;
  let settled = false;
  const promise = new Promise((yes) => {
    resolve = (value) => {
      if (settled) return false;
      settled = true;
      yes(value);
      return true;
    };
  });
  return { promise, resolve };
}
