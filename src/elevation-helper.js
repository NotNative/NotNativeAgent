#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { access, chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 1_048_576;

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const code = /^[a-z_]+(?::[a-z_]+)?$/u.test(error?.message) ? error.message : 'elevation_helper_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const envelope = parseEnvelope(process.argv.slice(2));
  const request = await consumeRequest(envelope);
  const result = await execute(request, envelope.cancelPath);
  await writeFile(envelope.resultPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(envelope.resultPath, 0o600).catch(() => undefined);
}

function parseEnvelope(argv) {
  if (argv.length !== 2 || argv[0] !== '--envelope') throw new Error('invalid_envelope');
  const value = JSON.parse(Buffer.from(argv[1], 'base64url').toString('utf8'));
  if (!value || !isAbsolute(value.requestPath) || !isAbsolute(value.resultPath) || !isAbsolute(value.cancelPath)
    || !/^[0-9a-f]{64}$/u.test(value.digest)) throw new Error('invalid_envelope');
  const root = dirname(resolve(value.requestPath));
  if ([value.resultPath, value.cancelPath].some((path) => dirname(resolve(path)) !== root)) throw new Error('invalid_envelope');
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
  if (!value || value.version !== '1.0') throw new Error('invalid_request:version');
  if (typeof value.request_id !== 'string' || value.request_id.length < 1
    || value.request_id.length > 180 || value.request_id.includes('\0')) {
    throw new Error('invalid_request:request_id');
  }
  if (!Number.isSafeInteger(value.issued_at) || !Number.isSafeInteger(value.expires_at)
    || value.expires_at >= value.issued_at + 120_001 || value.expires_at < Date.now()) {
    throw new Error('invalid_request:validity');
  }
  if (!isAbsolute(value.executable) || !isAbsolute(value.cwd)) throw new Error('invalid_request:path');
  if (typeof value.expected_effect !== 'string' || value.expected_effect.length < 1
    || value.expected_effect.length > 2048 || value.expected_effect.includes('\0')) {
    throw new Error('invalid_request:expected_effect');
  }
  if (!Array.isArray(value.args) || value.args.length > 64
    || value.args.some((item) => typeof item !== 'string'
      || item.length > 4096 || item.includes('\0'))) throw new Error('invalid_request:args');
  if (!Number.isSafeInteger(value.timeout_ms)
    || value.timeout_ms < 100 || value.timeout_ms > 3_600_000) throw new Error('invalid_request:timeout');
}

async function execute(request, cancelPath) {
  try {
    const result = await runExact(request, cancelPath);
    return {
      status: result.exit_code === 0 ? 'succeeded' : 'failed',
      reason_code: result.exit_code === 0 ? 'elevated_process_succeeded' : 'elevated_process_nonzero',
      ...result,
    };
  } catch (error) {
    return {
      status: 'failed', reason_code: elevationFailureCode(error),
      exit_code: null, signal: null, stdout: '', stderr: String(error.code ?? error.message ?? 'elevated_process_failed'),
    };
  }
}

function elevationFailureCode(error) {
  if (error.message === 'output_too_large') return 'elevated_output_too_large';
  if (error.message === 'timeout') return 'elevated_process_timeout';
  if (error.message === 'cancelled') return 'elevated_process_cancelled';
  return 'elevated_process_failed';
}

export function runExact(request, cancelPath, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const terminate = options.terminateTree ?? terminateTree;
  const checkAccess = options.access ?? access;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(request.executable, request.args, {
      cwd: request.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: safeEnvironment(process.env),
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const consume = (kind, chunk) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) { rejectOnce(new Error('output_too_large')); return; }
      if (kind === 'stdout') stdout.push(value); else stderr.push(value);
    };
    const rejectOnce = (error) => {
      if (settled) return; settled = true; cleanup();
      Promise.resolve().then(() => terminate(child)).then(
        () => reject(error),
        () => reject(error),
      );
    };
    const timer = setTimeout(() => rejectOnce(new Error('timeout')), request.timeout_ms);
    const cancellation = setInterval(async () => {
      try { await checkAccess(cancelPath); rejectOnce(new Error('cancelled')); } catch { /* not cancelled */ }
    }, 100);
    cancellation.unref?.();
    const onStdout = (chunk) => consume('stdout', chunk);
    const onStderr = (chunk) => consume('stderr', chunk);
    const onError = (error) => rejectOnce(error);
    const onExit = (code, signal) => {
      if (settled) return; settled = true; cleanup();
      resolve({
        exit_code: code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(cancellation);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function terminateTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true, stdio: 'ignore', shell: false,
      });
      const timer = setTimeout(() => { killer.kill('SIGKILL'); resolveKill(); }, 2_000);
      killer.once('error', () => { clearTimeout(timer); child.kill('SIGKILL'); resolveKill(); });
      killer.once('exit', () => { clearTimeout(timer); resolveKill(); });
    });
    if (child.exitCode === null) child.kill('SIGKILL');
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

function safeEnvironment(environment) {
  const names = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USER', 'LOGNAME', 'SHELL',
    'USERPROFILE', 'USERNAME', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
  return Object.fromEntries(names.filter((name) => environment[name]).map((name) => [name, environment[name]]));
}
