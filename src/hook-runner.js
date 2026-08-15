// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { ContractError } from './ids.js';
import { userDataPaths } from './product.js';

const MAX_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 262_144;
const FORBIDDEN_SHELL = /[|&;<>()`\r\n]|\$\(/u;

export async function runHook(subscription, bundle, payload, signal) {
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    return result('continue', 'hook_input_too_large');
  }
  let invocation;
  try { invocation = parseCommand(subscription.command); } catch (error) {
    return result('continue', error.code ?? 'invalid_hook_command');
  }
  return execute(invocation, subscription, bundle, input, signal);
}

function execute(invocation, subscription, bundle, input, parentSignal) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      cwd: bundle.directory, env: hookEnvironment(payloadEnvironment(bundle, input)),
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timeoutId); parentSignal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => { child.kill(); finish(result('continue', 'hook_cancelled')); };
    const timeoutId = setTimeout(() => { child.kill(); finish(result('continue', 'hook_timeout')); }, subscription.timeoutMs);
    parentSignal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      const appended = appendBounded(stdout, chunk); stdout = appended.value;
      if (appended.truncated) { child.kill(); finish(result('continue', 'hook_output_too_large')); }
    });
    child.stderr.on('data', (chunk) => {
      const appended = appendBounded(stderr, chunk); stderr = appended.value;
      if (appended.truncated) { child.kill(); finish(result('continue', 'hook_output_too_large')); }
    });
    child.on('error', (error) => finish(result('continue', 'hook_spawn_failed', null, stableErrorCode(error))));
    child.on('close', (code) => finish(interpret(code, stdout.toString('utf8'), stderr.toString('utf8'), subscription)));
    child.stdin.on('error', (error) => {
      child.kill(); finish(result('continue', 'hook_input_failed', null, stableErrorCode(error)));
    });
    child.stdin.end(input, 'utf8');
  });
}

function interpret(code, stdout, stderr, subscription) {
  if (code === 2) return result('deny', 'hook_denied', null, boundedReason(stderr));
  if (code !== 0) return result('continue', 'hook_failed');
  const text = stdout.trim();
  if (!text) return result('continue', 'hook_completed');
  let value;
  try { value = JSON.parse(text); } catch {
    const context = subscription.event === 'compaction' && subscription.phase === 'pre' ? text : null;
    return result('continue', context ? 'hook_context' : 'hook_completed', context);
  }
  if (value?.continue === false) return result('deny', 'hook_denied', null, boundedReason(value.stopReason));
  const context = value?.hookSpecificOutput?.additionalContext;
  return result('continue', context ? 'hook_context' : 'hook_completed', boundedContext(context));
}

export function parseCommand(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new ContractError('invalid_hook_command', 'hook command contains invalid data');
  }
  if (FORBIDDEN_SHELL.test(value)) throw new ContractError('unsafe_hook_command', 'shell operators are forbidden in hook commands');
  const tokens = [];
  let current = '';
  let quote = null;
  const input = value.trim();
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (character === '\\' && next && (next === quote || next === '\\' || (!quote && (/\s/u.test(next) || next === '"' || next === "'")))) {
      current += next; index += 1; continue;
    }
    if (quote) {
      if (character === quote) quote = null; else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/u.test(character)) { if (current) { tokens.push(current); current = ''; } }
    else current += character;
  }
  if (quote) throw new ContractError('invalid_hook_command', 'hook command quoting is invalid');
  if (current) tokens.push(current);
  if (tokens.length === 0 || tokens.length > 65) throw new ContractError('invalid_hook_command', 'hook command is empty or excessive');
  return Object.freeze({ command: tokens[0], args: Object.freeze(tokens.slice(1)) });
}

function appendBounded(existing, chunk) {
  const incoming = Buffer.from(chunk);
  const remaining = Math.max(0, MAX_OUTPUT_BYTES - existing.length);
  return {
    value: remaining === 0 ? existing : Buffer.concat([existing, incoming.subarray(0, remaining)]),
    truncated: incoming.length > remaining,
  };
}

function result(decision, code, additionalContext = null, reason = null) {
  return Object.freeze({ decision, code, additionalContext, reason });
}

function boundedContext(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_OUTPUT_BYTES) : null;
}

function boundedReason(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2048) : null;
}

function stableErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(error.code) ? error.code : null;
}

function payloadEnvironment(bundle, input) {
  const payload = JSON.parse(input);
  return {
    NNA_SESSION_ID: String(payload.session_id ?? ''), NNA_CWD: String(payload.cwd ?? ''),
    NNA_HOOK_BUNDLE: bundle.name,
    NNA_LOADED_SKILLS: Array.isArray(payload.loaded_skills) ? payload.loaded_skills.join(',') : '',
    NNM_GOVERNANCE_RECEIPTS: userDataPaths().nnmGovernanceReceipts,
  };
}

function hookEnvironment(extra) {
  const names = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME',
    'TMP', 'TEMP', 'TMPDIR', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'TERM',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PYTHONUTF8',
  ];
  const environment = {};
  for (const name of names) if (process.env[name] !== undefined) environment[name] = process.env[name];
  return { ...environment, ...extra, PYTHONUTF8: environment.PYTHONUTF8 ?? '1' };
}
