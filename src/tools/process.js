// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { ContractError } from '../ids.js';

export function processRunDefinition(paths) {
  return {
    name: 'process.run', version: 1,
    purpose: 'Run one bounded installed host program with explicit argv for local or remote tasks. Prefer a direct executable; shell interpreters are optional host software and receive semantic review. Root NNA may target host paths; hosted sessions remain workspace-bounded.',
    sideEffect: 'unknown', scope: 'workspace', cancellation: true, timeoutMs: 120_000,
    inputSchema: {
      type: 'object', properties: {
        executable: { type: 'string', minLength: 1, maxLength: 4096, description: 'Required installed command name or executable path. Do not include arguments in this field.' },
        // Keep the item-length boundary in local validation. Some otherwise compatible
        // llama.cpp grammar compilers reject maxLength when nested below array items.
        args: { type: 'array', items: { type: 'string' }, maxItems: 64, description: 'Ordered argument vector without the executable. Defaults to an empty array.' },
        cwd: { type: 'string', minLength: 1, maxLength: 4096, description: 'Working directory for the process. Defaults to the agent working directory.' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, description: 'Process deadline in milliseconds. Defaults to 60000.' },
      }, required: ['executable'], additionalProperties: false,
    },
    validate: async (args) => validateProcessRequest(paths, args),
    executor: (request, signal) => runProcess(request.args, signal),
  };
}

export function shellRunDefinition(paths) {
  return {
    name: 'shell.run', version: 1,
    purpose: 'Run a bounded script in the host platform shell. Use this for pipelines, redirection, environment expansion, and multi-command terminal work; use process.run for one exact executable and argv. The complete script is reviewed before execution.',
    sideEffect: 'unknown', scope: 'workspace', cancellation: true, timeoutMs: 3_600_000,
    inputSchema: {
      type: 'object', properties: {
        script: { type: 'string', minLength: 1, maxLength: 32768, description: 'Required complete shell script, including any pipelines, redirection, or multiple commands.' },
        shell: { type: 'string', enum: ['auto', 'powershell', 'pwsh', 'cmd', 'sh', 'bash'], description: 'Shell interpreter. Defaults to the native platform shell through auto.' },
        cwd: { type: 'string', minLength: 1, maxLength: 4096, description: 'Working directory for the script. Defaults to the agent working directory.' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 3600000, description: 'Script deadline in milliseconds. Defaults to 600000.' },
      }, required: ['script'], additionalProperties: false,
    },
    validate: async (args) => validateShellRequest(paths, args),
    executor: (request, signal) => runShell(request.args, signal),
  };
}

async function validateShellRequest(paths, input) {
  const allowed = new Set(['script', 'shell', 'cwd', 'timeout_ms']);
  if (!input || typeof input.script !== 'string' || input.script.trim().length < 1
    || input.script.length > 32768 || input.script.includes('\0')
    || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ContractError('shell_request_invalid', 'shell requires one non-empty bounded script');
  }
  if (/(?:bearer\s+|api[_-]?key\s*[=:]|token\s*[=:]|password\s*[=:])/iu.test(input.script)) {
    throw new ContractError('shell_secret_argument_forbidden', 'secret-like literal values cannot be placed in shell scripts');
  }
  const shell = input.shell ?? 'auto';
  if (!['auto', 'powershell', 'pwsh', 'cmd', 'sh', 'bash'].includes(shell)) {
    throw new ContractError('shell_interpreter_invalid', 'requested shell is not supported');
  }
  const cwd = await paths.resolveDirectory(input.cwd ?? '.');
  const timeoutMs = input.timeout_ms ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) {
    throw new ContractError('shell_timeout_invalid', 'shell timeout must be 100 to 3600000 milliseconds');
  }
  const invocation = shellInvocation(shell, input.script, process.platform);
  return {
    args: { script: input.script, shell: invocation.shell, cwd: cwd.path, timeout_ms: timeoutMs },
    resolved: {
      path: cwd.path, executable: invocation.executable, shell: invocation.shell, script: input.script,
      reviewComplexity: shellComplexity(input.script), reviewPurpose: shellReviewPurpose(input.script),
      insideWorkspace: cwd.insideWorkspace, recovery: cwd.recovery,
    },
  };
}

function runShell(input, signal) {
  const invocation = shellInvocation(input.shell, input.script);
  return runProcess({ ...input, executable: invocation.executable, args: invocation.args }, signal, true);
}

export function shellInvocation(requested, script, platform = process.platform) {
  const shell = requested === 'auto' ? (platform === 'win32' ? 'powershell' : 'sh') : requested;
  if (shell === 'powershell') return { shell, executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] };
  if (shell === 'pwsh') return { shell, executable: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] };
  if (shell === 'cmd') return { shell, executable: 'cmd.exe', args: ['/d', '/s', '/c', script] };
  if (shell === 'bash') return { shell, executable: 'bash', args: ['-c', script] };
  return { shell: 'sh', executable: 'sh', args: ['-c', script] };
}

function shellComplexity(script) {
  if (/(?:^|[;&|\n]\s*)(?:rm\s+-[^\n]*r[^\n]*f|format\b|diskpart\b|shutdown\b|reboot\b|git\s+(?:clean\s+-[^\n]*f|reset\s+--hard)|Remove-Item\b[^\n]*(?:-Recurse|-Force)|(?:del|erase|rmdir)\b)/iu.test(script)) return 'destructive_shell';
  if (/\r?\n|&&|\|\||[|;<>]/u.test(script)) return 'compound_shell';
  return 'simple_shell';
}

function shellReviewPurpose(script) {
  return /^\s*(?:ping|ping6|nslookup|host|dig|traceroute|tracert|pathping|Test-Connection|Resolve-DnsName)\b[^;&|\n]*\s*$/iu.test(script)
    ? 'network_diagnostic' : null;
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
    reviewPurpose: processReviewPurpose(executable, args), recovery: cwd.recovery,
  } };
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

export async function runProcess(input, signal, shellTool = false) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'process was cancelled');
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: operationalEnvironment(),
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
    return { content: JSON.stringify(result, null, 2), metadata: { exitCode: result.exit_code, shell: shellTool ? input.shell : false } };
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
  return basename(value).toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, '');
}
