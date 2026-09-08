// SPDX-License-Identifier: Apache-2.0
import { toolContinuationHint } from '../tools/loop.js';
import { completionEvidence, completionEvidenceHint } from './completion-evidence.js';
import { refreshReviewerCompletion } from './reviewer-completion.js';
import { assistantMessage, responseCandidateRecord } from './records.js';

export async function persistSupervisedResponse(active, supervised, persist) {
  if (supervised.preserveCandidate === true) {
    const candidate = responseCandidateRecord(active.turnId, active.stepText, active.stepId);
    await persist('response_candidate', candidate);
    // Invariant: memory learns about the candidate only after the journal accepts it.
    active.provisionalFinal = Object.freeze({ text: candidate.content, stepId: candidate.stepId });
    return null;
  }
  await persist('message', assistantMessage(active.turnId, active.stepText, {
    partial_data: true, stepId: active.stepId,
  }));
  return active.stepText;
}

export async function continueAfterTerminalDeclaration(engine, active, items, trustedHandoff, settleStep) {
  if (!isSuccessfulDeclarationBatch(items)) {
    if (items.some((item) => declarationName(item) !== 'turn_finish')) active.provisionalFinal = null;
    return null;
  }
  // Why: turn_finish is bookkeeping for the completion supervisor, not another unit of
  // user work. Charging it against the bounded work-step budget would reduce the useful
  // budget merely because the model followed the terminal-outcome protocol.
  refreshReviewerCompletion(engine, active);
  active.completionEvidence = completionEvidence(engine.transcript, active.turnId);
  const candidate = active.provisionalFinal ?? (active.stepText
    ? Object.freeze({ text: active.stepText, stepId: active.stepId })
    : null);
  if (candidate) {
    const supervised = engine.reliability.evaluateCompletion(
      active, candidate.text, engine.work?.snapshot(),
    );
    if (supervised.disposition !== 'continue') {
      // Why: the declaration is a typed settlement for the already-streamed answer.
      // Generating another answer after settlement duplicates visible output and gives a
      // later provider call an opportunity to diverge from the reviewed turn evidence.
      await settleStep(supervised.disposition);
      return Object.freeze({
        continue: false,
        text: candidate.text,
        outcome: supervised.disposition,
        deliverableStepId: candidate.stepId,
        terminalDeclarationSettled: true,
      });
    }
  }
  await settleStep('continued');
  engine.state.transition('preparing_continuation', { trigger: 'terminal_declaration_recorded', turnId: active.turnId });
  const evidenceHint = completionEvidenceHint(active.completionEvidence);
  return Object.freeze({
    continue: true, countModelStep: false,
    hint: [trustedHandoff?.hint ?? toolContinuationHint(items), evidenceHint].filter(Boolean).join('\n\n'),
  });
}

function isSuccessfulDeclarationBatch(items) {
  return items.length > 0 && items.every((item) => declarationName(item) === 'turn_finish'
    && item.result?.status === 'succeeded');
}

function declarationName(item) {
  return item.result?.tool_name ?? item.request?.toolName ?? item.call?.name;
}
