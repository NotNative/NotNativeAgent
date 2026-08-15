// SPDX-License-Identifier: Apache-2.0
import { RecoverySupervisor } from '../recovery.js';
import { ToolCallAssembler } from '../tools/calls.js';

const ENGINE_ORIGIN = 'engine';

export function createActiveTurn(turnId, requestId, recoveryOptions = {}) {
  const deferred = createDeferred();
  return {
    // Lifecycle and cancellation ownership.
    turnId, requestId, stepId: null, attemptId: null, authority: null,
    controller: new AbortController(), cancelled: false, finalized: false,
    text: '', stepText: '', committedStepText: null, finalText: '', usage: null, finishReason: null, reasoningBytes: 0,
    stepReasoningBytes: 0, reasoningFallbackPending: false, reasoningFallbackUsed: false,
    startedAt: Date.now(), toolCalls: 0,
    providerTerminal: false, toolAssembler: new ToolCallAssembler(),
    deltaSequence: 1, origin: ENGINE_ORIGIN, completion: deferred.promise,
    resolveCompletion: deferred.resolve, recovery: new RecoverySupervisor(recoveryOptions),
    enrichment: { memory: [], attachments: [], hooks: [], skills: [], projectIntake: null }, admission: null,
    prompt: '', modelName: '', unresolvedToolFailures: [], toolConstraints: [], contextRetryScale: 1,
    contextBytes: 0, contextTokens: 0,
    rawContextBytes: 0, rawContextTokens: 0, contextPressureTier: 'none',
    contextLimitTokens: null, contextMeasurementEnrichment: null,
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
