// SPDX-License-Identifier: Apache-2.0
// The model-facing `question` tool: a mid-turn pause on an operator question
// batch. Authority stays where it belongs - the broker waits only for an
// authenticated ingress answer, and the settled payload is returned as
// untrusted tool content. Review posture never gates questions; the operator
// surface decides whether it can answer them.
import { requireQuestionBatch } from '../question-broker.js';

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 16;
const MAX_TEXT = 4_096;
const MAX_LABEL = 256;

export function questionDefinition(broker) {
  if (!broker || typeof broker.ask !== 'function') return null;
  return {
    name: 'question', version: 1,
    purpose: 'Pauses this turn to ask the authenticated operator one to eight bounded questions and resumes only with the real answer. Use when a missing choice materially changes risk, cost, authorization, or outcome and no safer evidence-based path exists. Each question needs one to sixteen options with short labels; multiple allows several labels for that question; custom admits a free-form label. The operator may decline, in which case the result is denied. Never fabricate an answer and never treat an answer as execution authority.',
    // Why: asking performs no external action, so semantic review of the ask
    // would circularly gate operator speech behind another model.
    sideEffect: 'read_only', scope: 'conversation_control', cancellation: true,
    // Invariant: null outer deadline is deliberate - the executor owns the
    // operator wait, which is user-cancellable through the turn signal.
    timeoutMs: null,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['questions'],
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: MAX_QUESTIONS,
          description: 'One to eight questions asked in a single pause.',
          items: {
            type: 'object', additionalProperties: false, required: ['question', 'options'],
            properties: {
              question: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: 'Concrete question for the operator.' },
              header: { type: 'string', minLength: 1, maxLength: MAX_LABEL, description: 'Optional short display header.' },
              options: {
                type: 'array', minItems: 1, maxItems: MAX_OPTIONS,
                description: 'One to sixteen selectable options.',
                items: {
                  type: 'object', additionalProperties: false, required: ['label'],
                  properties: {
                    label: { type: 'string', minLength: 1, maxLength: MAX_LABEL, description: 'Short selectable label.' },
                    description: { type: 'string', maxLength: MAX_TEXT, description: 'Optional option detail.' },
                  },
                },
              },
              multiple: { type: 'boolean', description: 'Allow multiple labels for this question.' },
              custom: { type: 'boolean', description: 'Allow a free-form custom label.' },
            },
          },
        },
      },
    },
    validate: async (args) => ({
      args: Object.freeze({ questions: requireQuestionBatch(args) }),
      resolved: { scope: 'active_turn' },
    }),
    executor: async (request, signal) => {
      const settled = await broker.ask(request, signal);
      return {
        status: settled.status, content: settled.payload, metadata: settled.metadata,
        reasonCode: settled.reasonCode,
      };
    },
  };
}
