// SPDX-License-Identifier: Apache-2.0

// Security: serialize trusted code into the UAC command line. Never evaluate a mutable
// helper file after authentication. Each function imports only Node built-ins.
export function windowsAdminSource(envelope) {
  return [requestCancelled, commandControl, runWindowsCommand, windowsAdminWorker]
    .map((fn) => fn.toString()).join('\n')
    + `\nwindowsAdminWorker(${JSON.stringify(envelope)}).catch(()=>{process.exitCode=1});`;
}

async function requestCancelled(envelope) {
  const fs = require('node:fs/promises'), { join } = require('node:path');
  try { await fs.access(join(envelope.directory, 'cancel')); return true; }
  catch (error) { if (error.code !== 'ENOENT') return true; }
  try { await fs.access(join(envelope.directory, 'request.json')); return false; } catch { return true; }
}

function commandControl(child, envelope, finish) {
  const { spawn } = require('node:child_process');
  const state = { stdout: [], stderr: [], bytes: 0, reason: null, settled: false, cleanupTimer: null };
  state.stop = (code) => {
    if (state.settled || state.reason) return;
    state.reason = code;
    if (child.pid) {
      const killer = spawn(envelope.taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
      killer.unref();
    }
    // Why: termination cannot prove that a detached installer had no effect.
    state.cleanupTimer = setTimeout(() => {
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish({ status: 'unknown_effect', reasonCode: code, effectCertainty: 'unknown', exitCode: null });
    }, 3000);
  };
  state.consume = (chunks, chunk) => {
    const remaining = Math.max(0, 262144 - state.bytes);
    if (remaining) chunks.push(chunk.subarray(0, remaining));
    state.bytes += chunk.length;
    if (state.bytes > 262144) state.stop('elevated_output_too_large');
  };
  return state;
}

async function runWindowsCommand(request, envelope) {
  const fs = require('node:fs/promises'), { join } = require('node:path'), { spawn } = require('node:child_process');
  if (await requestCancelled(envelope)) return { status: 'denied', reasonCode: 'elevation_not_authorized', effectCertainty: 'none' };
  await fs.writeFile(join(envelope.directory, 'started'), 'started', { flag: 'wx' });
  const script = `$ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = 0; & {\n${request.script}\n}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  return new Promise((resolve) => {
    const child = spawn(envelope.powershell, args, {
      cwd: request.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (result) => {
      if (state.settled) return;
      state.settled = true; clearTimeout(timer); clearInterval(poll); clearTimeout(state.cleanupTimer);
      resolve({ ...result, stdout: Buffer.concat(state.stdout).toString('utf8'), stderr: Buffer.concat(state.stderr).toString('utf8') });
    };
    const state = commandControl(child, envelope, finish);
    const timer = setTimeout(() => state.stop('elevated_process_timeout'), request.timeout_ms);
    let checking = false;
    const poll = setInterval(async () => {
      if (checking || state.settled) return;
      checking = true;
      try { if (await requestCancelled(envelope)) state.stop('elevated_process_cancelled'); } finally { checking = false; }
    }, 100);
    child.stdout.on('data', (chunk) => state.consume(state.stdout, chunk));
    child.stderr.on('data', (chunk) => state.consume(state.stderr, chunk));
    child.on('error', () => finish({ status: 'failed', reasonCode: 'elevated_process_failed', effectCertainty: 'none', exitCode: null }));
    child.on('close', (exitCode, signal) => {
      const success = !state.reason && signal === null && request.accepted_exit_codes.includes(exitCode);
      finish({ status: success ? 'succeeded' : state.reason === 'elevated_process_timeout' ? 'timed_out'
        : state.reason === 'elevated_process_cancelled' ? 'cancelled' : 'failed',
      reasonCode: success ? null : state.reason ?? 'elevated_process_nonzero',
      effectCertainty: success ? 'completed' : 'unknown', exitCode, signal,
      rebootRequired: exitCode === 3010, outputTruncated: state.bytes > 262144 });
    });
  });
}

async function windowsAdminWorker(envelope) {
  const fs = require('node:fs/promises'), { createHash } = require('node:crypto'), { join } = require('node:path');
  let result;
  try {
    const path = join(envelope.directory, 'request.json');
    if ((await fs.stat(path)).size > 65536) throw new Error('request_bound');
    const bytes = await fs.readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== envelope.digest) throw new Error('request_drift');
    const request = JSON.parse(bytes);
    if (typeof request.script !== 'string' || !request.script.trim() || request.script.length > 8192
      || !Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 100 || request.timeout_ms > 3600000
      || !Array.isArray(request.accepted_exit_codes) || !request.accepted_exit_codes.includes(0)) throw new Error('request_invalid');
    result = await runWindowsCommand(request, envelope);
  } catch {
    let started = false;
    try { await fs.access(join(envelope.directory, 'started')); started = true; } catch { /* no start receipt */ }
    result = { status: 'failed', reasonCode: 'elevated_process_failed', effectCertainty: started ? 'unknown' : 'none' };
  }
  await fs.writeFile(join(envelope.directory, 'result.json'), JSON.stringify({ ...result, requestDigest: envelope.digest }), { flag: 'wx' });
}
