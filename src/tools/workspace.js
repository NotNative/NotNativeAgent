// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export function workspaceChangeDefinition(paths, control) {
  return {
    name: 'workspace.change', version: 1,
    purpose: 'Change the current working directory for this conversation to one existing directory. Use it when authenticated operator intent requests or requires a different working directory.',
    sideEffect: 'reversible', scope: 'conversation_workspace', cancellation: true, timeoutMs: 5_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Required existing directory that becomes the current working directory for this conversation.' },
      },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => key !== 'path')
        || typeof args.path !== 'string' || args.path.trim().length === 0) {
        throw new ContractError('tool_schema_invalid', 'workspace.change requires one non-empty path');
      }
      let resolved;
      try { resolved = await paths.resolveDirectory(args.path.trim()); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
        throw new ContractError('workspace_path_invalid', 'working directory does not exist', { cause: error });
      }
      return {
        args: { path: args.path.trim() },
        resolved: { ...resolved, priorWorkspace: paths.root, transition: 'working_directory' },
      };
    },
    executor: async (request, signal) => {
      if (signal?.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const result = await control.change(request.resolved.path);
      return {
        content: JSON.stringify({
          previous_working_directory: result.previousWorkspace,
          working_directory: result.workspaceRoot,
          changed: result.changed,
          project_guidance: 'reload_before_next_model_step',
        }),
        metadata: {
          previousWorkspace: result.previousWorkspace,
          workspaceRoot: result.workspaceRoot,
          changed: result.changed,
        },
      };
    },
  };
}
