// SPDX-License-Identifier: Apache-2.0
import { RecoverySupervisor } from './recovery.js';
import { ToolCallAssembler } from './tool-calls.js';

export function createActiveTurn(turnId, requestId, recoveryOptions = {}) {
  const deferred = createDeferred();
  return {
    turnId, requestId, stepId: null, attemptId: null, authority: null,
    controller: new AbortController(), cancelled: false, finalized: false,
    text: '', stepText: '', finalText: '', usage: null, finishReason: null, reasoningBytes: 0,
    startedAt: Date.now(), toolCalls: 0,
    providerTerminal: false, toolAssembler: new ToolCallAssembler(),
    deltaSequence: 1, origin: 'engine', completion: deferred.promise,
    resolveCompletion: deferred.resolve, recovery: new RecoverySupervisor(recoveryOptions),
    enrichment: { memory: [], attachments: [], hooks: [], skills: [], projectIntake: null }, admission: null,
    prompt: '', modelName: '', unresolvedToolFailures: [], contextRetryScale: 1,
    contextBytes: 0, contextTokens: 0, contextRetryBudgetBytes: null,
    compactionAttempts: 0, compactionFingerprints: new Set(),
  };
}

export function admissionFromRetry(item) {
  return Object.freeze({
    admitted: Object.freeze(item.state === 'admitted' ? [item] : []),
    failures: Object.freeze(item.state === 'admitted' ? [] : [item]),
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
