// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

// Why: completed/blocked/needs_input describe expected terminal states, while incomplete and
// failed let the model report an honest bounded failure without falsifying durable work state.
// denied, cancelled, and limit_reached remain engine-owned because only NNA can observe them.
const OUTCOMES = Object.freeze(['completed', 'blocked', 'incomplete', 'failed', 'needs_input']);
const MAX_REASON = 128;
const MAX_QUESTION = 1024;

export function turnFinishDefinition(control) {
  if (!control || typeof control.declare !== 'function') return null;
  return {
    name: 'turn.finish', version: 1,
    purpose: 'Declare the intended terminal turn outcome before the final response. NNA validates this declaration against durable work, tool failures, and evidence. Use completed after successful work, blocked when no authorized route remains, incomplete when bounded work remains unfinished, failed when the attempted objective failed, or needs_input with one concrete operator question.',
    // Why: this records model intent inside the active turn but performs no external action.
    // Semantic review would circularly ask another model to approve the model's own disposition;
    // deterministic completion supervision is the authority that accepts or rejects it.
    sideEffect: 'read_only', scope: 'conversation_control', cancellation: true, timeoutMs: 2_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['outcome'], properties: {
        outcome: { type: 'string', enum: OUTCOMES, description: 'Required intended terminal outcome.' },
        reason_code: { type: 'string', minLength: 1, maxLength: MAX_REASON, description: 'Required for blocked, incomplete, or failed. Stable snake_case reason for the disposition.' },
        question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION, description: 'Required for needs_input. One concrete question for the operator.' },
      },
    },
    validate: async (args) => ({ args: validateDeclaration(args), resolved: { scope: 'active_turn' } }),
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'turn completion declaration was cancelled');
      const declaration = control.declare(request.args);
      return {
        content: JSON.stringify({ accepted: true, ...declaration }),
        metadata: { declared_outcome: declaration.outcome },
      };
    },
  };
}

function validateDeclaration(value) {
  const keys = new Set(['outcome', 'reason_code', 'question']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key)) || !OUTCOMES.includes(value.outcome)) {
    throw new ContractError('tool_schema_invalid', 'turn.finish requires a supported outcome');
  }
  if (['blocked', 'incomplete', 'failed'].includes(value.outcome)) requireText(value.reason_code, 'reason_code', MAX_REASON);
  if (value.outcome === 'needs_input') requireText(value.question, 'question', MAX_QUESTION);
  if (!['blocked', 'incomplete', 'failed'].includes(value.outcome) && value.reason_code !== undefined) invalid('reason_code');
  if (value.outcome !== 'needs_input' && value.question !== undefined) invalid('question');
  return Object.freeze({
    outcome: value.outcome,
    reason_code: value.reason_code?.trim() ?? null,
    question: value.question?.trim() ?? null,
  });
}

function requireText(value, field, maximum) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum) invalid(field);
}

function invalid(field) {
  throw new ContractError('tool_schema_invalid', `turn.finish received an invalid ${field}`);
}
