// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { ContractError } from '../ids.js';

const OPERATIONS = new Set(['status', 'diff', 'diff_staged', 'log']);

export function gitInspectionDefinition(paths, options = {}) {
  return {
    name: 'git.inspect', version: 1,
    purpose: 'Inspect bounded Git status, working or staged changes, and recent history without constructing a shell command.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 30_000,
    inputSchema: {
      type: 'object', properties: {
        path: { type: 'string', maxLength: 4096, description: 'Git working-tree directory. Defaults to the agent working directory.' },
        operation: { type: 'string', enum: [...OPERATIONS], description: 'Required inspection: status, unstaged diff, staged diff, or recent log.' },
        max_entries: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum commits for the log operation. Defaults to 20.' },
      }, required: ['operation'], additionalProperties: false,
    },
    validate: async (input) => validate(paths, input),
    executor: (request, signal) => execute(request, signal, options.spawnProcess ?? spawn),
  };
}

async function validate(paths, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['path', 'operation', 'max_entries'].includes(key))
    || !OPERATIONS.has(input.operation)) {
    throw new ContractError('git_inspection_invalid', 'Git inspection requires a supported operation and bounded options');
  }
  const maxEntries = input.max_entries ?? 20;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100) {
    throw new ContractError('git_inspection_invalid', 'Git history limit must be between 1 and 100');
  }
  const resolved = await paths.resolveDirectory(input.path ?? '.');
  return {
    args: { path: resolved.path, operation: input.operation, max_entries: maxEntries },
    resolved: { ...resolved, operation: input.operation },
  };
}

async function execute(request, signal, spawnProcess) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'Git inspection was cancelled');
  const child = spawnProcess('git', gitArguments(request.args), {
    cwd: request.args.path, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collect(child, request.args.operation, signal);
}

function gitArguments(input) {
  const prefix = ['-c', 'color.ui=false', '-c', 'core.pager=cat'];
  if (input.operation === 'status') return [...prefix, 'status', '--short', '--branch', '--untracked-files=normal'];
  if (input.operation === 'diff') return [...prefix, 'diff', '--no-ext-diff', '--unified=3'];
  if (input.operation === 'diff_staged') return [...prefix, 'diff', '--cached', '--no-ext-diff', '--unified=3'];
  return [...prefix, 'log', '-n', String(input.max_entries), '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s'];
}

function collect(child, operation, signal) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let bytes = 0; let settled = false;
    const finish = (action) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); action(); };
    const consume = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > 262_144) { child.kill(); finish(() => reject(new ContractError('git_output_too_large', 'Git inspection output exceeded 256 KiB'))); return; }
      if (kind === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    const cancel = () => { child.kill(); finish(() => reject(new ContractError('tool_cancelled', 'Git inspection was cancelled'))); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new ContractError('tool_timeout', 'Git inspection exceeded 30 seconds'))); }, 30_000);
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));
    child.on('error', (error) => finish(() => reject(new ContractError('git_unavailable', error.code === 'ENOENT' ? 'Git is not installed or not available on PATH' : 'Git inspection could not start'))));
    child.on('close', (code) => finish(() => {
      if (code !== 0) { reject(new ContractError('git_repository_unavailable', 'The target is not an accessible Git repository')); return; }
      resolve({ content: stdout.trim() || 'no Git output', metadata: { operation, bytes: Buffer.byteLength(stdout), exit_code: code } });
    }));
  });
}
