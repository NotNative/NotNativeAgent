// SPDX-License-Identifier: Apache-2.0
import { toolContinuationHint } from '../tools/loop.js';
import { completionEvidence, completionEvidenceHint } from './completion-evidence.js';

export async function continueAfterTerminalDeclaration(engine, active, items, trustedHandoff, settleStep) {
  if (!isSuccessfulDeclarationBatch(items)) return null;
  // Why: turn.finish is bookkeeping for the completion supervisor, not another unit of
  // user work. Charging it against the bounded work-step budget would reduce the useful
  // budget merely because the model followed the terminal-outcome protocol.
  await settleStep('continued');
  active.completionEvidence = completionEvidence(engine.transcript, active.turnId);
  engine.state.transition('preparing_continuation', { trigger: 'terminal_declaration_recorded', turnId: active.turnId });
  const evidenceHint = completionEvidenceHint(active.completionEvidence);
  return Object.freeze({
    continue: true, countModelStep: false,
    hint: [trustedHandoff?.hint ?? toolContinuationHint(items), evidenceHint].filter(Boolean).join('\n\n'),
  });
}

function isSuccessfulDeclarationBatch(items) {
  return items.length > 0 && items.every((item) => declarationName(item) === 'turn.finish'
    && item.result?.status === 'succeeded');
}

function declarationName(item) {
  return item.result?.tool_name ?? item.request?.toolName ?? item.call?.name;
}
