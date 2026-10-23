// SPDX-License-Identifier: Apache-2.0
import { REVIEW_DELIVERY_FAILED_FINGERPRINT } from './persistence/reviewer-ledger.js';

export async function recordAndSettleAuthorization(reviewer, request, decision, context) {
  try {
    await reviewer.governance?.recordAuthorization(request, decision, context);
  } finally {
    // The event boundary may time out while durable governance is writing.
    // Check again here because the governor's check could precede that write.
    await settleUndeliveredApproval(reviewer.ledger, reviewer.governance, request.id);
  }
}

export async function settleUndeliveredApproval(ledger, governance, requestId) {
  const execution = ledger?.execution?.(requestId);
  if (execution?.terminal?.result_fingerprint !== REVIEW_DELIVERY_FAILED_FINGERPRINT
    || execution.terminal.effect_certainty !== 'none') return;
  const authorization = governance?.decision?.(execution.decisionId);
  if (authorization?.subjectRef !== requestId || authorization.outcome !== 'approve') return;
  // Invariant: an approval committed after its event deadline was never delivered
  // to the governor. Close its governance obligation only for the ledger's
  // synthetic no-effect terminal, never for a genuinely started tool.
  await governance.settleDecision(execution.decisionId, {
    status: 'cancelled', effectCertainty: 'none', resultFingerprint: REVIEW_DELIVERY_FAILED_FINGERPRINT,
    reasonCode: execution.terminal.reason_code,
  });
}
