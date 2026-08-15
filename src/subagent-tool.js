// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { SUBAGENT_TYPES } from './subagent-runtime.js';

const AGENT_TYPES = new Set(SUBAGENT_TYPES);
const MAX_TASK_CHARACTERS = 131_072;
const MAX_TASK_BYTES = 131_072;

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
      validateResult(result);
      const response = {
        agent_id: result.session_id, type: request.args.type, outcome: result.outcome,
        text: result.text, usage: result.usage ?? null, failure: result.failure ?? null,
      };
      return {
        // Type is intentionally repeated: content is model-visible while metadata is host-visible.
        content: safeStringify(response),
        metadata: { agent_id: result.session_id, type: request.args.type, outcome: result.outcome },
      };
    },
  };
}

function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.session_id !== 'string' || !result.session_id
    || typeof result.outcome !== 'string' || !result.outcome
    || (result.text !== undefined && typeof result.text !== 'string')) {
    throw new ContractError('subagent_result_invalid', 'sub-agent returned an invalid terminal result');
  }
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
