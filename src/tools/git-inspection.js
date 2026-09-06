// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { ContractError } from '../ids.js';

const OPERATIONS = new Set(['status', 'diff', 'diff_staged', 'log']);
const GIT_INSPECTION_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;

export function gitInspectionDefinition(paths, options = {}) {
  return {
    name: 'git_inspect', version: 1,
    purpose: 'Inspect bounded Git status, working or staged changes, and recent history without constructing a shell command.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: GIT_INSPECTION_TIMEOUT_MS,
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
  const options = { cwd: request.args.path, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const probe = await collect(spawnProcess('git', repositoryProbeArguments(), options), signal);
  if (probe.exitCode !== 0) {
    if (!reportsNonRepository(probe.stderr)) {
      throw new ContractError('git_repository_unavailable', 'The target Git repository could not be inspected');
    }
    // Why: a negative repository probe is a complete read-only observation. It must not
    // enter the unresolved-failure ledger or prevent an otherwise successful turn.
    return {
      content: 'The target directory is not a Git repository.',
      metadata: {
        operation: request.args.operation, bytes: Buffer.byteLength(probe.stderr),
        exit_code: probe.exitCode, target_exists: true,
        is_repository: false, observation_outcome: 'target_not_git_repository',
      },
    };
  }
  const result = await collect(spawnProcess('git', gitArguments(request.args), options), signal);
  if (result.exitCode !== 0) {
    throw new ContractError('git_repository_unavailable', 'The requested Git inspection could not be completed');
  }
  return {
    content: result.stdout.trim() || 'no Git output',
    metadata: {
      operation: request.args.operation, bytes: Buffer.byteLength(result.stdout),
      exit_code: result.exitCode, target_exists: true, is_repository: true,
    },
  };
}

function repositoryProbeArguments() {
  return ['-c', 'color.ui=false', '-c', 'core.pager=cat', 'rev-parse', '--git-dir'];
}

function gitArguments(input) {
  const prefix = ['-c', 'color.ui=false', '-c', 'core.pager=cat'];
  if (input.operation === 'status') return [...prefix, 'status', '--short', '--branch', '--untracked-files=normal'];
  if (input.operation === 'diff') return [...prefix, 'diff', '--no-ext-diff', '--unified=3'];
  if (input.operation === 'diff_staged') return [...prefix, 'diff', '--cached', '--no-ext-diff', '--unified=3'];
  return [...prefix, 'log', '-n', String(input.max_entries), '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s'];
}

function collect(child, signal) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let bytes = 0; let settled = false;
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      child.stdout.removeListener('data', consumeStdout); child.stdout.removeListener('error', streamError);
      child.stderr.removeListener('data', consumeStderr); child.stderr.removeListener('error', streamError);
    };
    const finish = (action) => { if (settled) return; settled = true; cleanup(); action(); };
    const terminate = () => { if (!child.killed) child.kill('SIGKILL'); };
    const consume = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT_BYTES) { terminate(); finish(() => reject(new ContractError('git_output_too_large', 'Git inspection output exceeded 256 KiB'))); return; }
      if (kind === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    const consumeStdout = (chunk) => consume('stdout', chunk);
    const consumeStderr = (chunk) => consume('stderr', chunk);
    const streamError = () => {
      terminate(); finish(() => reject(new ContractError('git_stream_failed', 'Git inspection output could not be read')));
    };
    const cancel = () => { terminate(); finish(() => reject(new ContractError('tool_cancelled', 'Git inspection was cancelled'))); };
    const timer = setTimeout(() => { terminate(); finish(() => reject(new ContractError('tool_timeout', 'Git inspection exceeded 30 seconds'))); }, GIT_INSPECTION_TIMEOUT_MS);
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', consumeStdout); child.stdout.on('error', streamError);
    child.stderr.on('data', consumeStderr); child.stderr.on('error', streamError);
    child.on('error', (error) => finish(() => reject(new ContractError('git_unavailable', error.code === 'ENOENT' ? 'Git is not installed or not available on PATH' : 'Git inspection could not start'))));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, exitCode: code })));
  });
}

function reportsNonRepository(stderr) {
  return /(?:not a git repository|not a git work tree)/iu.test(stderr);
}
