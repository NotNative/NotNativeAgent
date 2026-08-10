#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 1_048_576;

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { process.exitCode = 1; });
}

async function main() {
  const envelope = parseEnvelope(process.argv.slice(2));
  const request = await consumeRequest(envelope);
  const result = await execute(request);
  await writeFile(envelope.resultPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(envelope.resultPath, 0o600).catch(() => undefined);
}

function parseEnvelope(argv) {
  if (argv.length !== 2 || argv[0] !== '--envelope') throw new Error('invalid_envelope');
  const value = JSON.parse(Buffer.from(argv[1], 'base64url').toString('utf8'));
  if (!value || !isAbsolute(value.requestPath) || !isAbsolute(value.resultPath)
    || !/^[0-9a-f]{64}$/u.test(value.digest)) throw new Error('invalid_envelope');
  return value;
}

async function consumeRequest(envelope) {
  const bytes = await readFile(envelope.requestPath);
  const actual = Buffer.from(createHash('sha256').update(bytes).digest('hex'));
  const expected = Buffer.from(envelope.digest);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('request_drift');
  const consumed = `${envelope.requestPath}.consumed`;
  await rename(envelope.requestPath, consumed);
  const request = JSON.parse(bytes.toString('utf8'));
  validateRequest(request);
  return request;
}

function validateRequest(value) {
  const exact = value && value.version === '1.0' && typeof value.request_id === 'string'
    && Number.isSafeInteger(value.issued_at) && Number.isSafeInteger(value.expires_at)
    && value.expires_at >= Date.now() && value.expires_at - value.issued_at <= 120_000
    && isAbsolute(value.executable) && isAbsolute(value.cwd)
    && typeof value.expected_effect === 'string' && value.expected_effect.length > 0
    && value.expected_effect.length <= 2048 && !value.expected_effect.includes('\0')
    && Array.isArray(value.args) && value.args.length <= 64
    && value.args.every((item) => typeof item === 'string' && item.length <= 4096 && !item.includes('\0'))
    && Number.isSafeInteger(value.timeout_ms) && value.timeout_ms >= 100 && value.timeout_ms <= 3_600_000;
  if (!exact) throw new Error('invalid_request');
}

async function execute(request) {
  try {
    const result = await runExact(request);
    return {
      status: result.exit_code === 0 ? 'succeeded' : 'failed',
      reason_code: result.exit_code === 0 ? 'elevated_process_succeeded' : 'elevated_process_nonzero',
      ...result,
    };
  } catch (error) {
    return {
      status: 'failed', reason_code: error.message === 'output_too_large' ? 'elevated_output_too_large' : 'elevated_process_failed',
      exit_code: null, signal: null, stdout: '', stderr: String(error.code ?? error.message ?? 'elevated_process_failed'),
    };
  }
}

function runExact(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd, shell: false, windowsHide: true, env: safeEnvironment(process.env),
    });
    let stdout = '', stderr = '', bytes = 0, settled = false;
    const consume = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { child.kill('SIGKILL'); rejectOnce(new Error('output_too_large')); return; }
      if (kind === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    const rejectOnce = (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectOnce(new Error('timeout')); }, request.timeout_ms);
    child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));
    child.once('error', rejectOnce);
    child.once('exit', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ exit_code: code, signal, stdout, stderr });
    });
  });
}

function safeEnvironment(environment) {
  const names = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USER', 'LOGNAME', 'SHELL',
    'USERPROFILE', 'USERNAME', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
  return Object.fromEntries(names.filter((name) => environment[name]).map((name) => [name, environment[name]]));
}
