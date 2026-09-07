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
    name: 'turn_finish', version: 1,
    purpose: 'Records a typed terminal outcome when the turn is blocked, incomplete, failed, needs operator input, or an active completion gate requests a disposition. Ordinary clean completion requires no declaration. NNA validates the declaration against durable work, tool failures, and evidence. Completed is accepted only after a requesting gate is satisfied. Blocked, incomplete, and failed require reason_code. Needs_input requires question. Every other outcome forbids reason_code and question.',
    // Why: this records model intent inside the active turn but performs no external action.
    // Semantic review would circularly ask another model to approve the model's own disposition;
    // deterministic completion supervision is the authority that accepts or rejects it.
    sideEffect: 'read_only', scope: 'conversation_control', cancellation: true, timeoutMs: 2_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['outcome'], properties: {
        outcome: { type: 'string', enum: OUTCOMES, description: 'Required intended terminal outcome.' },
        reason_code: { type: 'string', minLength: 1, maxLength: MAX_REASON, description: 'Required only for blocked, incomplete, or failed. Forbidden for completed and needs_input. Stable snake_case reason for the disposition.' },
        question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION, description: 'Required only for needs_input. Forbidden for every other outcome. One concrete question for the operator.' },
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
    throw new ContractError('tool_schema_invalid', 'turn_finish requires a supported outcome');
  }
  if (['blocked', 'incomplete', 'failed'].includes(value.outcome)) requireText(value.reason_code, 'reason_code', MAX_REASON, value.outcome);
  if (value.outcome === 'needs_input') requireText(value.question, 'question', MAX_QUESTION, value.outcome);
  if (!['blocked', 'incomplete', 'failed'].includes(value.outcome) && value.reason_code !== undefined) {
    throw new ContractError('tool_schema_invalid', 'reason_code is accepted only when outcome is blocked, incomplete, or failed; omit reason_code for completed and needs_input');
  }
  if (value.outcome !== 'needs_input' && value.question !== undefined) {
    throw new ContractError('tool_schema_invalid', 'question is accepted only when outcome is needs_input; omit question for every other outcome');
  }
  return Object.freeze({
    outcome: value.outcome,
    reason_code: value.reason_code?.trim() ?? null,
    question: value.question?.trim() ?? null,
  });
}

function requireText(value, field, maximum, outcome) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum) {
    throw new ContractError('tool_schema_invalid', `turn_finish requires a valid ${field} when outcome is ${outcome}`);
  }
}
