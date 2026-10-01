// SPDX-License-Identifier: Apache-2.0
// QuestionBroker: mid-turn operator questions on interactive surfaces. Mirrors
// the interactive permission broker's lifetime contract but pauses without a
// timeout: an unanswered question never times out into denial; only an ingress
// answer, an explicit decline, or turn abort settles it. The `question_response`
// / `question_decline` canonical commands route through the engine's ingress
// (interactive surfaces only). Review posture does not gate questions. The
// broker stays surface-neutral: consumers watching `emit.asked` / `emit.settled`
// render the transport voice.
import { ContractError, newId } from './ids.js';

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 16;
const MAX_TEXT = 4_096;
const MAX_LABEL = 256;
const MAX_ANSWER_ROWS = 8;
const MAX_ANSWER_COLUMNS = MAX_OPTIONS;

export class QuestionBroker {
  #pending = new Map();

  constructor(options = {}) {
    this.output = options.output ?? (async () => undefined);
    this.emit = typeof options.emit === 'object' && options.emit !== null ? options.emit : {};
    this.maxPending = options.maxPending ?? 16;
  }

  // Asked from the mid-turn `question` tool executor. Resolves with the
  // settled tool result ({status,payload,...}) once the operator answers,
  // declines, or the turn aborts. Idempotent ask re-entry simply re-emits.
  // Never resolves from a timeout.
  async ask(request, signal) {
    const batch = requireQuestionBatch(request.args);
    const existing = [...this.#pending.values()].find((item) => item.request.id === request.id);
    const pending = existing ?? {
      token: newId('que'), request, batch,
      createdAt: Date.now(), narrative: batchNarrative(request.args), settled: false,
      deferred: createDeferred(),
    };
    if (existing !== undefined) return existing.deferred.promise;
    if (this.#pending.size >= this.maxPending) {
      throw new ContractError('question_request_invalid', 'interactive question queue is full');
    }
    pending.abort = () => this.#settleAborted(pending);
    signal?.addEventListener('abort', pending.abort, { once: true });
    this.#pending.set(pending.token, pending);
    this.emit?.asked?.(pending);
    try {
      if (signal?.aborted) this.#settleAborted(pending);
      else await this.output(questionRecord(pending));
      return await pending.deferred.promise;
    } finally {
      if (signal) signal.removeEventListener('abort', pending.abort);
      this.#pending.delete(pending.token);
    }
  }

  // Ingress entry point for `question_response` (wire: /question/:id/reply).
  answer(command, principal) {
    const pending = this.requirePending(command.question_token);
    const answers = requireAnswerMatrix(command.answers);
    if (answers.length !== pending.batch.length || answers.some((row, index) => {
      const question = pending.batch[index];
      return !question.multiple && row.length !== 1 || new Set(row).size !== row.length
        || !question.custom && row.some((label) => !question.options.some((option) => option.label === label));
    })) throw new ContractError('question_request_invalid', 'answers must match each question and its choices');
    this.#settle(pending, {
      status: 'succeeded', payload: JSON.stringify(answers), reasonCode: 'operator_answered',
      principal, completedAt: Date.now(), metadata: { answers },
    }, 'replied');
    return { accepted: true, question_token: pending.token, answers };
  }

  // Ingress entry point for `question_decline` (wire: /question/:id/reject).
  decline(command, principal) {
    const pending = this.requirePending(command.question_token);
    this.#settle(pending, {
      status: 'denied', payload: 'The user dismissed this question', reasonCode: 'operator_declined',
      principal, completedAt: Date.now(), metadata: { effect_certainty: 'none' },
    }, 'rejected');
    return { accepted: true, question_token: pending.token, declined: true };
  }

  requirePending(token) {
    const pending = this.#pending.get(token ?? null);
    if (!pending || pending.settled) {
      throw new ContractError('question_unknown', 'interactive question is stale or unavailable');
    }
    return pending;
  }

  snapshot() {
    return Object.freeze([...this.#pending.values()].map((item) => Object.freeze({
      token: item.token, tool_request_id: item.request.id, narrative: item.narrative, questions: item.batch,
    })));
  }

  #settleAborted(pending) {
    this.#settle(pending, {
      status: 'denied', payload: 'question cancelled by turn abort', reasonCode: 'operator_cancelled',
      principal: 'engine', completedAt: Date.now(), metadata: { effect_certainty: 'none' },
    }, 'rejected');
  }

  #settle(pending, result, kind) {
    if (pending.settled) return false;
    pending.settled = true;
    pending.deferred.resolve(result);
    this.emit?.settled?.(pending, kind);
    this.#pending.delete(pending.token);
    return true;
  }
}

function batchNarrative(args) {
  const first = args?.questions?.[0]?.question;
  return optionalText(first, MAX_TEXT) ?? 'operator question';
}

export function questionRecord(pending) {
  return {
    version: '1.0', type: 'question_prompt', question_token: pending.token,
    tool_request_id: pending.request.id, callID: pending.request.providerCallId ?? null,
    messageID: null, sessionID: null, questions: pending.batch, narrative: pending.narrative,
  };
}

// The batch shape keeps OpenCode question-tool parity: questions[] with
// question/header text, options with label/description, multiple/custom flags.
export function requireQuestionBatch(args) {
  const questions = args?.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) {
    throw new ContractError('question_batch_invalid', `questions must be an array of 1 to ${MAX_QUESTIONS} items`);
  }
  return questions.map((item) => requireQuestion(item));
}

function requireQuestion(item) {
  const question = requiredText(item?.question, MAX_TEXT, 'questions[].question');
  if (!Array.isArray(item.options) || item.options.length === 0 || item.options.length > MAX_OPTIONS) {
    throw new ContractError('question_batch_invalid', `questions[].options must be 1 to ${MAX_OPTIONS} options`);
  }
  const options = item.options.map((option, index) => optionRecord(option, index));
  // Invariant: labels are the operator selection and answer wire identities.
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new ContractError('question_batch_invalid', 'question option labels must be unique');
  }
  return Object.freeze({
    question, header: optionalText(item?.header, MAX_LABEL) ?? question.slice(0, 64),
    options, multiple: item?.multiple === true, custom: item?.custom === true,
  });
}

function optionRecord(option, index) {
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new ContractError('question_batch_invalid', 'option is malformed');
  }
  const label = requiredText(option.label, MAX_LABEL, 'options[].label');
  return Object.freeze({ label, description: optionalText(option.description, MAX_TEXT) ?? '' });
}

export function requireAnswerMatrix(answers) {
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > MAX_ANSWER_ROWS) {
    throw new ContractError('question_request_invalid', 'answers must be a non-empty matrix of at most 8 rows');
  }
  return answers.map((row, rowIndex) => answerRow(row, rowIndex));
}

function answerRow(row, rowIndex) {
  if (!Array.isArray(row) || row.length === 0 || row.length > MAX_ANSWER_COLUMNS) {
    throw new ContractError('question_request_invalid', 'each answers row must be 1 to 16 labels');
  }
  const labels = row.map((label) => requiredText(label, MAX_LABEL, 'answers[][]', 'question_request_invalid'));
  return Object.freeze(labels);
}

function requiredText(value, max, field, code = 'question_batch_invalid') {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ContractError(code, `${field} must be bounded non-empty text`);
  }
  return value;
}
function optionalText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : null;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
