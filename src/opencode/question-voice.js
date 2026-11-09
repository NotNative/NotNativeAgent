// SPDX-License-Identifier: Apache-2.0
// The OpenCode surface's question transport: parked tool-call questions travel
// the wire bus as scoped events and the operator's reply enters through the
// same authenticated ingress as prompt traffic. Split from `sessions.js` so
// the session-operations file stays readable and under its line budget.
import { QuestionBroker } from '../question-broker.js';
import { newId, ContractError } from '../ids.js';

export function questionOperations(workspace) {
  return {
    questionReply(token, body = {}) {
      const session = requireQuestionSession(workspace, token);
      return session.ingress.submit({
        version: '1.0', type: 'question_response', request_id: newId('oc_qreply'),
        question_token: token, answers: body.answers ?? [],
      }, 'opencode-wire');
    },
    questionReject(token, body = {}) {
      const session = requireQuestionSession(workspace, token);
      return session.ingress.submit({
        version: '1.0', type: 'question_decline', request_id: newId('oc_qreject'),
        question_token: token, ...(body.reason === undefined ? {} : { reason: body.reason }),
      }, 'opencode-wire');
    },
  };
}

function requireQuestionSession(workspace, token) {
  const owner = workspace.pendingQuestions.get(token ?? '');
  const session = owner === undefined ? null : workspace.registry.get(owner);
  if (!session) throw new ContractError('question_unknown', 'interactive question is unavailable on this surface');
  return session;
}

export function attachQuestionVoice(workspace, ids, options, observe) {
  const { bus, pendingQuestions } = workspace;
  return new QuestionBroker({
    output: async (record) => { observe(record); options.logger?.record(record, { sessionId: ids.sessionId }); },
    emit: {
      asked: (pending) => {
        pendingQuestions.set(pending.token, ids.ocId);
        publishQuestion(bus, ids, 'question.asked', {
          question_token: pending.token, narrative: pending.narrative, questions: pending.batch,
        });
      },
      settled: (pending, kind) => {
        pendingQuestions.delete(pending.token);
        publishQuestion(bus, ids, `question.${kind}`, { question_token: pending.token, kind });
      },
    },
  });
}

function publishQuestion(bus, ids, type, properties) {
  bus.publishSession({
    directory: ids.directory, project: ids.projectID, sessionID: ids.ocId, type,
    properties: Object.freeze({ sessionID: ids.ocId, ...properties }),
  });
}
