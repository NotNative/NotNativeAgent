// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { ContractError } from './ids.js';

export function processRunDefinition(paths) {
  return {
    name: 'process.run', version: 1,
    purpose: 'Run one bounded process with explicit argv. Root NNA may target host paths; hosted sessions remain workspace-bounded.',
    sideEffect: 'unknown', scope: 'workspace', cancellation: true, timeoutMs: 120_000,
    inputSchema: {
      type: 'object', properties: {
        executable: { type: 'string', minLength: 1, maxLength: 4096 },
        // Keep the item-length boundary in local validation. Some otherwise compatible
        // llama.cpp grammar compilers reject maxLength when nested below array items.
        args: { type: 'array', items: { type: 'string' }, maxItems: 64 },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000 },
      }, required: ['executable'], additionalProperties: false,
    },
    validate: async (args) => validateProcessRequest(paths, args),
    executor: (request, signal) => runProcess(request.args, signal),
  };
}

async function validateProcessRequest(paths, input) {
  const allowed = new Set(['executable', 'args', 'cwd', 'timeout_ms']);
  if (!input || typeof input.executable !== 'string' || input.executable.length < 1 || input.executable.length > 4096
    || input.executable.includes('\0')
    || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ContractError('process_request_invalid', 'process requires a simple executable name and bounded options');
  }
  const executable = normalizedExecutable(input.executable);
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 64 || args.some((item) => typeof item !== 'string' || item.length > 4096 || item.includes('\0'))) {
    throw new ContractError('process_args_invalid', 'process argv is invalid or exceeds bounds');
  }
  if (args.some((item) => /(?:bearer\s+|api[_-]?key\s*[=:]|token\s*[=:]|password\s*[=:])/iu.test(item))) {
    throw new ContractError('process_secret_argument_forbidden', 'secret-like values cannot be placed in process argv');
  }
  const cwd = await paths.resolveDirectory(input.cwd ?? '.');
  const timeoutMs = input.timeout_ms ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new ContractError('process_timeout_invalid', 'process timeout must be 100 to 120000 milliseconds');
  }
  return { args: { executable: input.executable, args: [...args], cwd: cwd.path, timeout_ms: timeoutMs }, resolved: {
    path: cwd.path, executable: input.executable, argv: [...args], shell: false,
    reviewComplexity: processComplexity(executable, args), insideWorkspace: cwd.insideWorkspace,
    recovery: cwd.recovery,
  } };
}

function processComplexity(executable, args) {
  if (['rm', 'rmdir', 'del', 'erase', 'format', 'shutdown', 'reboot', 'diskpart', 'taskkill'].includes(executable)) return 'destructive_command';
  if (['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh', 'fish', 'wsl'].includes(executable)) return 'shell_command';
  if (['node', 'python', 'python3', 'ruby', 'perl'].includes(executable)
    && args.some((item) => ['-e', '--eval', '-c', '--command'].includes(item.toLowerCase()))) return 'inline_code';
  if (executable === 'git' && (args[0] === 'clean' || (args[0] === 'reset' && args.includes('--hard')))) return 'destructive_command';
  if (['npm', 'npx', 'pnpm', 'yarn', 'bun'].includes(executable)
    && ['run', 'exec', 'x', 'dlx'].includes(args[0]?.toLowerCase())) return 'opaque_package_script';
  if (args.length > 16) return 'large_argv';
  if (args.some((item) => /[*?{}[\]$`]|\(\?[<!=:]|\\[dDsSwW]/u.test(item))) return 'interpreted_pattern';
  if (args.some((item) => ['--eval', '--execute', '--command'].includes(item.toLowerCase()))) return 'dynamic_flag';
  return 'simple_argv';
}

async function runProcess(input, signal) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'process was cancelled');
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: minimalEnvironment(),
  });
  const output = collectOutput(child, 1_048_576);
  const abort = () => terminateTree(child);
  signal.addEventListener('abort', abort, { once: true });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      terminateTree(child);
      resolve({ boundary: 'timeout' });
    }, input.timeout_ms);
  });
  try {
    const settled = await Promise.race([output.then((value) => ({ value })), timeout]);
    if (signal.aborted) throw new ContractError('tool_cancelled', 'process was cancelled');
    if (settled.boundary === 'timeout') throw new ContractError('tool_timeout', 'process exceeded its deadline');
    const result = settled.value;
    return { content: JSON.stringify(result, null, 2), metadata: { exitCode: result.exit_code, shell: false } };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

function collectOutput(child, limit) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', bytes = 0, timedOut = false;
    const consume = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > limit) { terminateTree(child); reject(new ContractError('process_output_too_large', 'process output exceeded 1 MiB')); return; }
      if (kind === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ exit_code: code, signal, stdout, stderr, timedOut }));
    child.markTimedOut = () => { timedOut = true; };
  });
}

function terminateTree(child) {
  child.markTimedOut?.();
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.unref();
    const escalation = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 250);
    escalation.unref();
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    const escalation = setTimeout(() => {
      if (child.exitCode !== null) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, 250);
    escalation.unref();
  }
}

function minimalEnvironment() {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'NO_COLOR',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SSH_AUTH_SOCK',
  ];
  return Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}

function normalizedExecutable(value) {
  return basename(value).toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, '');
}
