// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { SUBAGENT_TYPES } from './subagent-runtime.js';

const AGENT_TYPES = new Set(SUBAGENT_TYPES);
const MAX_TASK_CHARACTERS = 131_072;
const MAX_TASK_BYTES = 131_072;
const TERMINAL_OUTCOMES = new Set(['completed', 'failed', 'cancelled', 'denied']);
const USAGE_FIELDS = new Set(['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'total_tokens',
  'inputTokens', 'outputTokens', 'totalTokens']);
const ACCOUNTING_FIELDS = new Set(['schema', 'attempts', 'measured_attempts', 'estimated_attempts', 'mixed_attempts',
  'measured_total_tokens', 'estimated_unreported_tokens', 'accounted_input_tokens', 'accounted_output_tokens',
  'accounted_total_tokens', 'measurement', 'by_role']);

export function subagentDefinition(control) {
  return {
    name: 'agent.run', version: 1,
    purpose: 'Run one bounded foreground sub-agent with the configured Sub-agents provider route and return its terminal result.',
    sideEffect: 'reversible', scope: 'subagent', parallelGroup: 'subagent', cancellation: true, timeoutMs: 3_600_000,
    maxOutputBytes: 2_097_152,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['type', 'task'],
      properties: {
        type: { type: 'string', enum: [...AGENT_TYPES], description: 'Required specialist role for the bounded foreground sub-agent.' },
        task: { type: 'string', minLength: 1, maxLength: MAX_TASK_CHARACTERS, description: 'Required self-contained assignment, including relevant scope, constraints, and desired result.' },
      },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => !['type', 'task'].includes(key))
        || !AGENT_TYPES.has(args.type) || typeof args.task !== 'string'
        || args.task.trim().length < 1 || args.task.length > MAX_TASK_CHARACTERS
        || Buffer.byteLength(args.task, 'utf8') > MAX_TASK_BYTES) {
        throw new ContractError('subagent_request_invalid', 'agent.run requires a supported type and bounded non-empty task');
      }
      return {
        args: { type: args.type, task: args.task.trim() },
        resolved: { path: control.workspaceRoot, insideWorkspace: true, recovery: 'git_tracked', agentType: args.type },
      };
    },
    executor: async (request, signal) => {
      let result;
      try { result = await control.run(request.args, signal); }
      catch (error) {
        if (error instanceof ContractError) throw error;
        throw new ContractError('subagent_execution_failed', 'sub-agent execution failed', { cause: error });
      }
      const validated = validateResult(result);
      const response = {
        agent_id: validated.session_id, type: request.args.type, outcome: validated.outcome,
        text: validated.text, usage: validated.usage,
        token_accounting: validated.token_accounting, failure: validated.failure,
      };
      return {
        // Type is intentionally repeated: content is model-visible while metadata is host-visible.
        content: safeStringify(response),
        metadata: {
          agent_id: validated.session_id, type: request.args.type, outcome: validated.outcome,
          token_accounting: validated.token_accounting,
        },
      };
    },
  };
}

function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.session_id !== 'string' || !result.session_id
    || !TERMINAL_OUTCOMES.has(result.outcome)
    || (result.text !== undefined && typeof result.text !== 'string')) {
    throw new ContractError('subagent_result_invalid', 'sub-agent returned an invalid terminal result');
  }
  return Object.freeze({
    session_id: result.session_id, outcome: result.outcome, text: result.text,
    usage: numericRecord(result.usage, USAGE_FIELDS),
    token_accounting: accountingRecord(result.token_accounting),
    failure: failureRecord(result.failure),
  });
}

function numericRecord(value, allowed) {
  if (value === undefined || value === null) return null;
  if (!plainRecord(value)) throw new ContractError('subagent_result_invalid', 'sub-agent accounting must be a plain object');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (!Number.isSafeInteger(item) || item < 0) throw new ContractError('subagent_result_invalid', 'sub-agent accounting contains an invalid count');
    result[key] = item;
  }
  return Object.freeze(result);
}

function accountingRecord(value) {
  if (value === undefined || value === null) return null;
  if (!plainRecord(value)) throw new ContractError('subagent_result_invalid', 'sub-agent token accounting must be a plain object');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ACCOUNTING_FIELDS.has(key)) continue;
    if (key === 'schema' || key === 'measurement') {
      if (typeof item !== 'string' || item.length > 64) throw new ContractError('subagent_result_invalid', 'sub-agent token accounting has an invalid label');
      result[key] = item;
    } else if (key === 'by_role') result.by_role = roleAccounting(item);
    else {
      if (!Number.isSafeInteger(item) || item < 0) throw new ContractError('subagent_result_invalid', 'sub-agent token accounting contains an invalid count');
      result[key] = item;
    }
  }
  return Object.freeze(result);
}

function roleAccounting(value) {
  if (!plainRecord(value) || Object.keys(value).length > 16) throw new ContractError('subagent_result_invalid', 'sub-agent role accounting is invalid');
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([role, accounting]) => {
    if (role.length > 64) throw new ContractError('subagent_result_invalid', 'sub-agent role accounting is invalid');
    return [role, numericRecord(accounting, ACCOUNTING_FIELDS)];
  })));
}

function failureRecord(value) {
  if (value === undefined || value === null) return null;
  if (!plainRecord(value)) throw new ContractError('subagent_result_invalid', 'sub-agent failure must be a plain object');
  return Object.freeze({
    code: boundedString(value.code), category: boundedString(value.category), retryable: value.retryable === true,
  });
}

function boundedString(value) { return typeof value === 'string' && value.length <= 128 ? value : null; }
function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item !== 'object' || item === null) return item;
      if (seen.has(item)) return '[circular]';
      seen.add(item);
      return item;
    }, 2);
  } catch (error) {
    throw new ContractError('subagent_result_invalid', 'sub-agent result could not be serialized', { cause: error });
  }
}
