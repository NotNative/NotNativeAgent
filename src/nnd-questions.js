// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { QuestionBroker } from './question-broker.js';
import { requirePrincipal, samePrincipal } from './nnd-session-helpers.js';

export function nndQuestionBroker(engine) {
  return new QuestionBroker({
    output: (record) => engine.output({ ...record, session_id: engine.sessionId }),
    emit: { settled: (pending, kind) => {
      void engine.output({ type: 'question_settled', session_id: engine.sessionId, question_token: pending.token, kind }).catch((error) => {
        try { engine.telemetry?.record('nnd.question.output_failed', 'failed', { code: error?.code ?? 'output_failed' }); }
        catch { /* Why: observational diagnostics cannot change a settled answer. */ }
      });
    } },
  });
}

export function observeNndQuestion(context, record, publish) {
  if (record.type === 'question_prompt') {
    const pending = context.engine.questionBroker?.snapshot().find((item) => item.token === record.question_token);
    if (pending) publish('question.asked', { id: pending.token, sessionID: context.sessionId, questions: pending.questions });
    return true;
  }
  if (record.type === 'question_settled') {
    if (['replied', 'rejected'].includes(record.kind)) publish(`question.${record.kind}`, {
      requestID: record.question_token, sessionID: context.sessionId,
    });
    return true;
  }
  return false;
}

export function listNndQuestions(contexts, principal) {
  requirePrincipal(principal);
  const questions = [];
  for (const context of contexts.values()) {
    if (context.closing || !samePrincipal(context, principal)) continue;
    const broker = context.engine.questionBroker;
    if (broker === null) continue;
    if (!broker || typeof broker.snapshot !== 'function') throw new ContractError('nnd_pending_unavailable', 'NND question observation is unavailable');
    for (const item of broker.snapshot()) {
      questions.push({ id: item.token, sessionID: context.sessionId, questions: item.questions });
    }
  }
  if (questions.length > 1024 || Buffer.byteLength(JSON.stringify(questions), 'utf8') > 2_097_152) {
    throw new ContractError('nnd_pending_unavailable', 'NND question observation exceeds its bound');
  }
  return questions;
}

export async function settleNndQuestion(contexts, token, principal, body, action) {
  requirePrincipal(principal);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => action === 'reply' ? key !== 'answers' : true)) {
    throw new ContractError('question_request_invalid', 'question settlement body is invalid');
  }
  for (const context of contexts.values()) {
    if (context.closing || !samePrincipal(context, principal)
      || !context.engine.questionBroker?.snapshot().some((item) => item.token === token)) continue;
    const command = { version: '1.0', type: action === 'reply' ? 'question_response' : 'question_decline',
      request_id: newId('nnd_question'), question_token: token, ...(action === 'reply' ? { answers: body.answers } : {}) };
    const result = await context.ingress.submit(command, principal);
    if (result.accepted !== true) throw new ContractError('question_unknown', 'question is stale or unavailable');
    return true;
  }
  throw new ContractError('question_unknown', 'question is stale or unavailable');
}
