// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { ContractError } from '../ids.js';
import { normalizeShellExecutionError, shellReliabilitySignals, shellToolGuidance } from '../reliability/host-environment.js';
import { inlineInterpreterGuidance, inlineInterpreterInvocation } from '../reliability/command-shaping.js';
import { portableExecutableName } from '../reliability/executable-name.js';
import { detachedProcessInvocation, longRunningForegroundInvocation } from '../reliability/process-lifecycle.js';

const MAX_SCRIPT_LENGTH = 32_768;
const MAX_FIELD_LENGTH = 4_096;
const MAX_ARG_COUNT = 64;
const MAX_ACCEPTED_EXIT_CODES = 16;
const MAX_EXIT_CODE = 255;
const MAX_PROCESS_TIMEOUT_MS = 120_000;
const MAX_SHELL_TIMEOUT_MS = 3_600_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const TERMINATION_ESCALATION_MS = 250;
const SECRET_LITERAL = /(?:bearer\s*[:=]?\s+|(?:api[_-]?key|token|password)\s*["']?\s*[:=]\s*["']?)/iu;

export function processRunDefinition(paths, references = null) {
  const inlineGuidance = inlineInterpreterGuidance();
  return {
    name: 'process.run', version: 1,
    purpose: `Run one bounded installed host program with explicit argv for local or remote tasks. Prefer a direct executable; shell interpreters are optional host software and receive semantic review. ${inlineGuidance} Root NNA may target host paths; hosted sessions remain workspace-bounded.`,
    sideEffect: 'unknown', scope: 'workspace', cancellation: true, timeoutMs: 120_000,
    inputSchema: {
      type: 'object', properties: {
        executable: { type: 'string', minLength: 1, maxLength: 4096, description: 'Required installed command name or executable path. Do not include arguments in this field.' },
        // Keep the item-length boundary in local validation. Some otherwise compatible
        // llama.cpp grammar compilers reject maxLength when nested below array items.
        args: { type: 'array', items: { type: 'string' }, maxItems: 64, description: `Ordered argument vector without the executable. Defaults to an empty array. ${inlineGuidance}` },
        cwd: { type: 'string', minLength: 1, maxLength: 4096, description: 'Working directory for the process. Defaults to the agent working directory.' },
        stdin_ref: { type: 'string', maxLength: 180, description: `Optional nna_ref_draft identifier whose exact stored text is sent to standard input. Prefer this for generated multi-statement interpreter source; for example, node args ["-"] or python args ["-"].` },
        accepted_exit_codes: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 }, maxItems: 16, description: 'Exit codes that count as successful completion. Must include 0 and defaults to [0]. Add codes only when the invoked program documents them as expected results.' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, description: 'Process deadline in milliseconds. Defaults to 60000.' },
      }, required: ['executable'], additionalProperties: false,
    },
    validate: async (args) => validateProcessRequest(paths, args, references),
    executor: (request, signal) => runProcess(request.args, signal, false, references),
  };
}

export function shellRunDefinition(paths, references = null, platform = process.platform) {
  const guidance = shellToolGuidance(platform);
  return {
    name: 'shell.run', version: 1,
    purpose: `Run a bounded foreground terminal workflow in the host platform shell. ${guidance} Use this for ordinary command-line programs as well as pipelines, redirection, expansion, or multiple commands; prefer a more specific structured NNA tool when one describes the operation. The workflow must normally terminate within this call. For workspace web verification use web.browse navigate with path; it owns a temporary server, so do not start python -m http.server or install browser automation in the project. Do not use Start-Process, Start-Job, nohup, disown, background &, or equivalent detachment unless authenticated user intent explicitly requests a persistent or background process; detached requests receive mandatory intent review. Keep one coherent purpose per call when practical. Avoid large loops, nested substitutions, deeply nested quoting, and combining mutation with verification. The complete script is reviewed before execution. Handle expected predicate statuses explicitly: diff and no-match grep commonly exit 1, while pipefail can expose an upstream SIGPIPE from pipelines ending in head.`,
    sideEffect: 'unknown', scope: 'workspace', cancellation: true, timeoutMs: 3_600_000,
    inputSchema: {
      type: 'object', properties: {
        script: { type: 'string', minLength: 1, maxLength: 32768, description: `Required complete foreground script using the selected interpreter's exact syntax. NNA does not translate syntax. Detaching a process requires explicit authenticated user intent for that persistent or background process. ${guidance}` },
        shell: { type: 'string', enum: ['auto', 'powershell', 'pwsh', 'cmd', 'sh', 'bash'], description: `Interpreter; defaults to auto. ${guidance}` },
        cwd: { type: 'string', minLength: 1, maxLength: 4096, description: 'Working directory for the script. Defaults to the agent working directory.' },
        stdin_ref: { type: 'string', maxLength: 180, description: 'Optional nna_ref_draft identifier whose exact stored text is sent to standard input.' },
        accepted_exit_codes: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 }, maxItems: 16, description: 'Exit codes that count as successful completion. Must include 0 and defaults to [0]. For example, [0, 1] may be appropriate for a documented comparison result; do not use it to mask unrelated failures in a compound script.' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 3600000, description: 'Script deadline in milliseconds. Defaults to 600000.' },
      }, required: ['script'], additionalProperties: false,
    },
    validate: async (args) => validateShellRequest(paths, args, references),
    executor: (request, signal) => runShell(request.args, signal, references),
  };
}

async function validateShellRequest(paths, input, references) {
  const allowed = new Set(['script', 'shell', 'cwd', 'timeout_ms', 'stdin_ref', 'accepted_exit_codes']);
  if (!input || typeof input.script !== 'string' || input.script.trim().length < 1
    || input.script.length > MAX_SCRIPT_LENGTH || input.script.includes('\0')
    || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ContractError('shell_request_invalid', 'shell requires one non-empty bounded script');
  }
  if (SECRET_LITERAL.test(input.script)) {
    throw new ContractError('shell_secret_argument_forbidden', 'secret-like literal values cannot be placed in shell scripts');
  }
  const shell = input.shell ?? 'auto';
  if (!['auto', 'powershell', 'pwsh', 'cmd', 'sh', 'bash'].includes(shell)) {
    throw new ContractError('shell_interpreter_invalid', 'requested shell is not supported');
  }
  const cwd = await paths.resolveDirectory(input.cwd ?? '.');
  const timeoutMs = input.timeout_ms ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_SHELL_TIMEOUT_MS) {
    throw new ContractError('shell_timeout_invalid', 'shell timeout must be 100 to 3600000 milliseconds');
  }
  const invocation = shellInvocation(shell, input.script, process.platform);
  const stdinRef = validateStdinReference(input.stdin_ref, references);
  const acceptedExitCodes = validateAcceptedExitCodes(input.accepted_exit_codes, 'shell_exit_codes_invalid');
  const reliabilitySignals = shellReliabilitySignals(input.script, invocation.shell);
  return {
    args: { script: input.script, shell: invocation.shell, cwd: cwd.path, timeout_ms: timeoutMs,
      accepted_exit_codes: acceptedExitCodes, ...(stdinRef ? { stdin_ref: stdinRef } : {}) },
    resolved: {
      path: cwd.path, executable: invocation.executable, shell: invocation.shell, script: input.script,
      reviewComplexity: shellComplexity(input.script, reliabilitySignals), reliabilitySignals,
      reviewPurpose: shellReviewPurpose(input.script),
      insideWorkspace: cwd.insideWorkspace, recovery: cwd.recovery,
    },
  };
}

async function runShell(input, signal, references) {
  const invocation = shellInvocation(input.shell, input.script);
  try {
    return await runProcess({ ...input, executable: invocation.executable, args: invocation.args }, signal, true, references);
  } catch (error) {
    throw normalizeShellExecutionError(error, invocation.shell);
  }
}

export function shellInvocation(requested, script, platform = process.platform) {
  const shell = requested === 'auto' ? (platform === 'win32' ? 'powershell' : 'sh') : requested;
  if (shell === 'powershell') return { shell, executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] };
  if (shell === 'pwsh') return { shell, executable: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] };
  if (shell === 'cmd') return { shell, executable: 'cmd.exe', args: ['/d', '/s', '/c', script] };
  if (shell === 'bash') return { shell, executable: 'bash', args: ['-c', script] };
  return { shell: 'sh', executable: 'sh', args: ['-c', script] };
}

function shellComplexity(script, signals = shellReliabilitySignals(script)) {
  if (/(?:^|[;&|\n]\s*)(?:rm\s+-[^\n]*r[^\n]*f|format\b|diskpart\b|shutdown\b|reboot\b|git\s+(?:clean\s+-[^\n]*f|reset\s+--hard)|Remove-Item\b[^\n]*(?:-Recurse|-Force)|(?:del|erase|rmdir)\b)/iu.test(script)) return 'destructive_shell';
  if (signals.includes('detached_process')) return 'detached_shell';
  if (signals.includes('long_running_foreground')) return 'long_running_foreground_shell';
  if (signals.length >= 2) return 'fragile_shell';
  if (/\r?\n|&&|\|\||[|;<>]/u.test(script)) return 'compound_shell';
  return 'simple_shell';
}

function shellReviewPurpose(script) {
  return /^\s*(?:ping|ping6|nslookup|host|dig|traceroute|tracert|pathping|Test-Connection|Resolve-DnsName)\b[^;&|\n]*\s*$/iu.test(script)
    ? 'network_diagnostic' : null;
}

async function validateProcessRequest(paths, input, references) {
  const allowed = new Set(['executable', 'args', 'cwd', 'timeout_ms', 'stdin_ref', 'accepted_exit_codes']);
  if (!input || typeof input.executable !== 'string' || input.executable.length < 1 || input.executable.length > MAX_FIELD_LENGTH
    || input.executable.includes('\0')
    || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ContractError('process_request_invalid', 'process requires a simple executable name and bounded options');
  }
  const executable = normalizedExecutable(input.executable);
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARG_COUNT
    || args.some((item) => typeof item !== 'string' || item.length > MAX_FIELD_LENGTH || item.includes('\0'))) {
    throw new ContractError('process_args_invalid', 'process argv is invalid or exceeds bounds');
  }
  if (args.some((item) => SECRET_LITERAL.test(item))) {
    throw new ContractError('process_secret_argument_forbidden', 'secret-like values cannot be placed in process argv');
  }
  const cwd = await paths.resolveDirectory(input.cwd ?? '.');
  const timeoutMs = input.timeout_ms ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new ContractError('process_timeout_invalid', 'process timeout must be 100 to 120000 milliseconds');
  }
  const stdinRef = validateStdinReference(input.stdin_ref, references);
  const acceptedExitCodes = validateAcceptedExitCodes(input.accepted_exit_codes, 'process_exit_codes_invalid');
  return { args: { executable: input.executable, args: [...args], cwd: cwd.path, timeout_ms: timeoutMs,
    accepted_exit_codes: acceptedExitCodes, ...(stdinRef ? { stdin_ref: stdinRef } : {}) }, resolved: {
    path: cwd.path, executable: input.executable, argv: [...args], shell: false,
    reviewComplexity: processComplexity(executable, args),
    reliabilitySignals: processReliabilitySignals(executable, args),
    insideWorkspace: cwd.insideWorkspace,
    reviewPurpose: processReviewPurpose(executable, args), recovery: cwd.recovery,
  } };
}

function processReliabilitySignals(executable, args) {
  const signals = [];
  if (inlineInterpreterInvocation(executable, args)) signals.push('inline_interpreter_code');
  const commandIndex = args.findIndex((item) => /^(?:-c|-command|\/c)$/iu.test(item));
  const lifecycleSource = commandIndex >= 0 ? args[commandIndex + 1] : args.join(' ');
  if (detachedProcessInvocation(lifecycleSource, executable)) {
    signals.push('detached_process');
  } else if (longRunningForegroundInvocation(`${executable} ${args.join(' ')}`)) {
    signals.push('long_running_foreground');
  }
  return Object.freeze(signals);
}

function processReviewPurpose(executable, args) {
  if (['ping', 'ping6', 'nslookup', 'host', 'dig', 'traceroute', 'tracert', 'pathping'].includes(executable)) {
    return 'network_diagnostic';
  }
  if (!['powershell', 'pwsh'].includes(executable) || args.length !== 2
    || !/^(?:-c|-command)$/iu.test(args[0])) return null;
  const command = args[1].trim();
  return /^(?:Test-Connection\s+(?:-ComputerName\s+)?[A-Za-z0-9._:-]+(?:\s+-Count\s+\d{1,3})?|Resolve-DnsName\s+(?:-Name\s+)?[A-Za-z0-9._:-]+)$/iu.test(command)
    ? 'network_diagnostic' : null;
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

export async function runProcess(input, signal, shellTool = false, references = null) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'process was cancelled');
  const stdin = input.stdin_ref ? references?.resolve(input.stdin_ref, 'draft').value : null;
  if (input.stdin_ref && typeof stdin !== 'string') throw new ContractError('reference_missing', 'stdin draft reference is unavailable or expired');
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: operationalEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin ?? '');
  const output = collectOutput(child, MAX_OUTPUT_BYTES);
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
    const acceptedExitCodes = input.accepted_exit_codes ?? [0];
    const succeeded = result.signal === null && acceptedExitCodes.includes(result.exit_code);
    const completedNonzero = result.signal === null && Number.isSafeInteger(result.exit_code);
    return {
      ...(succeeded ? {} : {
        status: completedNonzero ? 'completed_nonzero' : 'failed',
        reasonCode: result.signal === null ? 'process_exit_nonzero' : 'process_signal_exit',
      }),
      content: JSON.stringify(result, null, 2),
      metadata: { exitCode: result.exit_code, signal: result.signal,
        acceptedExitCodes: [...acceptedExitCodes], shell: shellTool ? input.shell : false },
    };
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
  if (child.terminationStarted) return;
  child.terminationStarted = true;
  child.markTimedOut?.();
  if (child.exitCode !== null || !Number.isSafeInteger(child.pid)) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.unref();
    const escalation = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, TERMINATION_ESCALATION_MS);
    escalation.unref();
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    const escalation = setTimeout(() => {
      if (child.exitCode !== null) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, TERMINATION_ESCALATION_MS);
    escalation.unref();
  }
}

export function operationalEnvironment(environment = process.env) {
  const allowed = [
    // Executable, shell, and operating-system discovery.
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'windir', 'SystemDrive', 'ComSpec', 'OS',
    'ProgramData', 'ALLUSERSPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
    'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PSModulePath',
    // User identity and per-user application/configuration paths. These are locations, not credentials.
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'LOGONSERVER', 'APPDATA', 'LOCALAPPDATA', 'PUBLIC',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    // Locale, terminal behavior, temporary storage, and an already-authorized user SSH agent.
    'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  ];
  return Object.fromEntries(allowed.filter((key) => environment[key]).map((key) => [key, environment[key]]));
}

function normalizedExecutable(value) {
  return portableExecutableName(value);
}

function validateStdinReference(value, references) {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new ContractError('process_stdin_ref_invalid', 'stdin_ref must be an nna_ref_draft identifier');
  if (!references) throw new ContractError('reference_unavailable', 'draft references are unavailable for this process tool');
  references.resolve(value, 'draft');
  return value;
}

function validateAcceptedExitCodes(value, code) {
  const exitCodes = value ?? [0];
  if (!Array.isArray(exitCodes) || exitCodes.length < 1 || exitCodes.length > MAX_ACCEPTED_EXIT_CODES
    || !exitCodes.includes(0) || new Set(exitCodes).size !== exitCodes.length
    || exitCodes.some((item) => !Number.isSafeInteger(item) || item < 0 || item > MAX_EXIT_CODE)) {
    throw new ContractError(code, 'accepted exit codes must be 1 to 16 unique integers from 0 through 255 and include 0');
  }
  return Object.freeze([...exitCodes]);
}
