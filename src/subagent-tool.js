// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const AGENT_TYPES = new Set(['general', 'planner', 'coder', 'tester', 'reviewer']);

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
        task: { type: 'string', minLength: 1, maxLength: 131_072, description: 'Required self-contained assignment, including relevant scope, constraints, and desired result.' },
      },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => !['type', 'task'].includes(key))
        || !AGENT_TYPES.has(args.type) || typeof args.task !== 'string'
        || args.task.trim().length < 1 || Buffer.byteLength(args.task, 'utf8') > 131_072) {
        throw new ContractError('subagent_request_invalid', 'agent.run requires a supported type and bounded non-empty task');
      }
      return {
        args: { type: args.type, task: args.task.trim() },
        resolved: { path: control.workspaceRoot, insideWorkspace: true, recovery: 'git_tracked', agentType: args.type },
      };
    },
    executor: async (request, signal) => {
      const result = await control.run(request.args, signal);
      return {
        content: JSON.stringify({
          agent_id: result.session_id, type: request.args.type, outcome: result.outcome,
          text: result.text, usage: result.usage ?? null, failure: result.failure ?? null,
        }, null, 2),
        metadata: { agent_id: result.session_id, type: request.args.type, outcome: result.outcome },
      };
    },
  };
}
