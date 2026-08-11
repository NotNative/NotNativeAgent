// SPDX-License-Identifier: Apache-2.0
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join, parse } from 'node:path';
import { ContractError } from './ids.js';

const MAX_TIMEOUT_MS = 3_600_000;

export function elevationDefinition(paths, broker, options = {}) {
  if (!broker || typeof broker.execute !== 'function') return null;
  return {
    name: 'system.elevate', version: 1,
    purpose: 'Run one exact host executable with operating-system elevation after mandatory semantic review, a fresh one-shot local operator confirmation, and native UAC or sudo authentication. Interactive shells are rejected: shell executables require an explicit non-interactive command or script in argv. Never supplies, stores, or exposes an administrator password.',
    sideEffect: 'unknown', scope: 'host', cancellation: false, timeoutMs: MAX_TIMEOUT_MS + 60_000,
    operatorConfirmation: 'one_shot',
    inputSchema: {
      type: 'object', properties: {
        executable: { type: 'string', minLength: 1, maxLength: 4096 },
        args: { type: 'array', items: { type: 'string' }, maxItems: 64 },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        reason: { type: 'string', minLength: 1, maxLength: 1024 },
        expected_effect: { type: 'string', minLength: 1, maxLength: 2048 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: MAX_TIMEOUT_MS },
      }, required: ['executable', 'reason', 'expected_effect'], additionalProperties: false,
    },
    validate: (args) => validateElevation(paths, args, options),
    executor: (request, signal) => broker.execute(request, signal),
  };
}

async function validateElevation(paths, input, options) {
  requireRequestShape(input);
  const args = validateArguments(input.args ?? []);
  rejectSecretLiterals([input.reason, input.expected_effect, ...args]);
  const cwd = await paths.resolveDirectory(input.cwd ?? '.');
  const executable = await resolveExecutable(input.executable, options);
  assertNonInteractiveElevation(executable, args);
  const timeoutMs = input.timeout_ms ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ContractError('elevation_timeout_invalid', 'elevation timeout must be 100 to 3600000 milliseconds');
  }
  return {
    args: {
      executable, args, cwd: cwd.path, reason: input.reason.trim(),
      expected_effect: input.expected_effect.trim(), timeout_ms: timeoutMs,
    },
    resolved: {
      path: executable, executable, argv: args, cwd: cwd.path, insideWorkspace: cwd.insideWorkspace,
      reviewComplexity: 'privileged_execution', reviewPurpose: 'host_elevation', recovery: cwd.recovery,
    },
  };
}

export function assertNonInteractiveElevation(executable, args) {
  const name = basename(executable).toLowerCase().replace(/\.exe$/u, '');
  if (['powershell', 'pwsh'].includes(name)) {
    requireCommandArgument(args, ['-command', '-c', '-encodedcommand', '-e', '-file', '-f']);
    return;
  }
  if (name === 'cmd') {
    requireCommandArgument(args, ['/c']);
    return;
  }
  if (['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish'].includes(name)) {
    const commandIndex = args.findIndex((item) => item.toLowerCase() === '-c');
    const script = args.find((item) => !item.startsWith('-'));
    if ((commandIndex < 0 || !args[commandIndex + 1]?.trim()) && !script) rejectInteractiveShell();
  }
}

function requireCommandArgument(args, commandFlags) {
  const index = args.findIndex((item) => commandFlags.includes(item.toLowerCase()));
  if (index < 0 || !args[index + 1]?.trim()) rejectInteractiveShell();
}

function rejectInteractiveShell() {
  throw new ContractError(
    'elevation_interactive_shell_forbidden',
    'elevation cannot open an interactive shell; provide an explicit non-interactive command or script in argv',
  );
}

function requireRequestShape(input) {
  const allowed = new Set(['executable', 'args', 'cwd', 'reason', 'expected_effect', 'timeout_ms']);
  const bounded = (value, maximum) => typeof value === 'string' && value.trim().length > 0
    && value.length <= maximum && !value.includes('\0');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !bounded(input.executable, 4096) || !bounded(input.reason, 1024)
    || !bounded(input.expected_effect, 2048) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ContractError('elevation_request_invalid', 'elevation requires an executable, reason, and expected effect');
  }
}

function validateArguments(args) {
  if (!Array.isArray(args) || args.length > 64
    || args.some((item) => typeof item !== 'string' || item.length > 4096 || item.includes('\0'))) {
    throw new ContractError('elevation_args_invalid', 'elevated argv is invalid or exceeds bounds');
  }
  return [...args];
}

function rejectSecretLiterals(values) {
  if (values.some((value) => /(?:bearer\s+|api[_-]?key\s*[=:]|token\s*[=:]|password\s*[=:])/iu.test(value))) {
    throw new ContractError('elevation_secret_argument_forbidden', 'secret-like literal values cannot be placed in elevated requests');
  }
}

async function resolveExecutable(value, options) {
  const platform = options.platform ?? process.platform;
  if (isAbsolute(value)) return executableFile(value);
  if (parse(value).dir) {
    throw new ContractError('elevation_executable_invalid', 'elevated executables must use an absolute path or an installed command name');
  }
  const environment = options.environment ?? process.env;
  const pathValue = environment.PATH ?? environment.Path ?? '';
  const suffixes = platform === 'win32' ? windowsSuffixes(value, environment.PATHEXT) : [''];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      try { return await executableFile(join(directory, `${value}${suffix}`)); } catch { /* continue bounded PATH search */ }
    }
  }
  throw new ContractError('elevation_executable_not_found', 'elevated executable was not found in the installed command path');
}

function windowsSuffixes(value, pathExt) {
  if (extname(value)) return [''];
  return String(pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((item) => item.toLowerCase());
}

async function executableFile(path) {
  try { await access(path, constants.X_OK); return path; } catch {
    throw new ContractError('elevation_executable_not_found', 'elevated executable is unavailable');
  }
}
