// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';

export async function settleConsoleQuestion(workspace, kind, answers, principal) {
  const session = workspace._active();
  const view = workspace.projection.sessions.get(session.id);
  const pending = view?.pendingQuestion;
  if (!pending) throw new ContractError('question_unknown', 'no interactive question is pending');
  const command = kind === 'answer'
    ? { version: '1.0', type: 'question_response', request_id: newId('tui'),
      question_token: pending.token, answers }
    : { version: '1.0', type: 'question_decline', request_id: newId('tui'),
      question_token: pending.token, reason: 'dismissed' };
  const result = await session.ingress.submit(command, principal);
  if (result.accepted && view.pendingQuestion?.token === pending.token) {
    view.pendingQuestion = view.questionQueue.shift() ?? null;
    workspace.onChange();
  }
  return result;
}
