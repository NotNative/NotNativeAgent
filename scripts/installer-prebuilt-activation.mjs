// SPDX-License-Identifier: Apache-2.0
/** Starts a retained NNA activation and proves its public controller without starting NND. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { probeNativeAttach, readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';

const execute = promisify(execFile);
const OPERATIONS = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const GENERATIONS = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function compileHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readBoundedFile(path, limit) {
  try {
    const size = statSync(path).size;
    if (size > limit) fail('native_activation_evidence_oversized');
    const bytes = Buffer.alloc(size);
    const handle = openSync(path, 'r');
    try { if (size && readSync(handle, bytes, 0, size, 0) !== size) fail('native_activation_evidence_unavailable'); }
    finally { closeSync(handle); }
    return bytes;
  } catch (error) { fail(error.code ? error.code : 'native_activation_evidence_unavailable'); }
}
function readTail(path, limit) {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, limit);
    const bytes = Buffer.alloc(length);
    const handle = openSync(path, 'r');
    try { if (size && readSync(handle, bytes, 0, length, size - length) !== length) return null; }
    finally { closeSync(handle); }
    return bytes;
  } catch { return null; }
}
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function cleanEnvironment(dataRoot) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$|NNA_HOME$|NNA_INTEGRATION_TOKEN$|NNA_PRINCIPAL$|NNA_HARNESS_URL$|NNA_NND_.*|NND_.*)$/u.test(name))),
    NNA_HOME: dataRoot };
}
async function packageStatus(runtime, timeout = 30000) {
  try {
    const { stdout } = await execute(runtime.node, [runtime.cli, 'nnd', 'package', 'status'], {
      cwd: runtime.root, env: cleanEnvironment(runtime.dataRoot), windowsHide: true,
      shell: false, timeout, maxBuffer: 16384,
    });
    const status = JSON.parse(stdout);
    if (status?.registered !== true || status?.valid !== true || typeof status.root !== 'string'
      || typeof status.version !== 'string' || Object.keys(status).sort().join(',') !== 'registered,root,valid,version') {
      fail('native_package_status_invalid');
    }
    return status;
  } catch (error) {
    throw error.code ? error : new Error('native_package_status_unavailable');
  }
}
function validateReadiness(value, { stageOperationId, operationId, candidateSha256 }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'candidate_sha256,endpoint,generation,operation_id,stage_operation_id,state'
    || value.state !== 'public_controller_attached'
    || value.operation_id !== operationId || value.stage_operation_id !== stageOperationId
    || value.candidate_sha256 !== candidateSha256
    || typeof value.generation !== 'string' || !GENERATIONS.test(value.generation)
    || typeof value.endpoint !== 'string') fail('native_activation_frame_invalid');
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { fail('native_activation_frame_invalid'); }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || !/^(?:[1-9]\d{0,4})$/.test(endpoint.port)) fail('native_activation_frame_invalid');
}
function lastReadyFrame(text, identity) {
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line);
      validateReadiness(frame, identity);
      return frame;
    } catch (error) { if (error.code === 'native_activation_frame_invalid') throw error; }
  }
  return null;
}
export async function activatePrebuiltSlot(nnaRoot, stageOperationId, candidateSha256 = process.env.NND_PREFLIGHT_CANDIDATE_SHA256) {
  if (typeof nnaRoot !== 'string' || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(nnaRoot)
    || !OPERATIONS.test(stageOperationId) || typeof candidateSha256 !== 'string'
    || !SHA256.test(candidateSha256)) fail('activation_call_invalid');
  const runtime = readSelectedNativeRuntime(nnaRoot);
  const operationId = crypto.randomUUID();
  const logRoot = join(runtime.root, 'private-activation');
  const outLog = join(logRoot, `${operationId}.out.log`);
  const errorLog = join(logRoot, `${operationId}.err.log`);
  const child = startRetainedNna(runtime, stageOperationId, operationId);
  try {
    const readiness = await awaitRetainedReadiness(child, join(runtime.root, 'private-activation',
      `${operationId}.out.log`), stageOperationId, operationId, candidateSha256);
    return await verifyRetainedController({ child, runtime, readiness, stageOperationId, candidateSha256 });
  } catch (error) {
    throw new Error(error.code ? error.code : 'native_activation_failed');
  }
}

function startRetainedNna(runtime, stageOperationId, operationId) {
  const logRoot = join(runtime.root, 'private-activation');
  mkdirSync(logRoot, { recursive: true });
  const outHandle = openSync(join(logRoot, `${operationId}.out.log`), 'a');
  const errorHandle = openSync(join(logRoot, `${operationId}.err.log`), 'a');
  const child = spawn(runtime.node, [runtime.cli, 'nnd', 'service', 'activate-slot',
    runtime.root, stageOperationId, operationId], {
    cwd: runtime.root, detached: true, windowsHide: true,
    stdio: ['ignore', outHandle, errorHandle], env: cleanEnvironment(runtime.dataRoot),
  });
  child.unref();
  closeSync(outHandle); closeSync(errorHandle);
  return child;
}

function awaitRetainedReadiness(child, outLog, stageOperationId, operationId, candidateSha256) {
  return new Promise((accept, reject) => {
    // The native trial, publication, and retirement sequence has multiple bounded phases.
    const deadline = Date.now() + 45 * 60 * 1000;
    let text = '';
    const finish = code => reject(Object.assign(new Error(code), { code }));
    child.once('exit', (exitCode, signal) => finish(
      exitCode === 0 ? 'native_activation_wait_invalid' : `native_activation_exit_${exitCode ?? signal}`));
    (async () => {
      while (Date.now() < deadline) {
        try {
          const bytes = readTail(outLog, 65536);
          if (bytes === null) { await delay(200); continue; }
          const chunk = bytes.toString('utf8');
          if (text === chunk) { await delay(200); continue; }
          text = chunk;
          const frame = lastReadyFrame(text, { stageOperationId, operationId, candidateSha256 });
          if (frame) return accept(frame);
        } catch (error) {
          if (error.code === 'native_activation_frame_invalid' || error.code === 'native_activation_output_oversized') return finish(error);
          if (error.code !== 'ENOENT') return finish('native_activation_log_unavailable');
        }
        await delay(200);
      }
      finish('native_activation_timeout');
    })();
  });
}

// Retirement cleanup removes the staged candidate file; the terminal commit
// and its cleared witness are the durable receipts that survive publication.
const TERMINAL_KEYS = ['child_process_identity', 'completion_sha256', 'data_id', 'decision_sha256',
  'discovery_sha256', 'generation', 'installation_id', 'marker_sha256', 'operation_id', 'plan_sha256',
  'protocol', 'registration_revision', 'stage_operation_id', 'state'];
const CLEARED_KEYS = [...TERMINAL_KEYS, 'terminal_sha256'].sort();
function verifyRetirementReceipts(runtime, { operationId, stageOperationId, generation }) {
  const root = join(runtime.dataRoot, 'runtime', 'nnd', 'install-slots');
  const commitBytes = readBoundedFile(join(root, 'activation-retirement-commit.json'), 4096);
  const clearedBytes = readBoundedFile(join(root, 'activation-retirement-cleared.json'), 4096);
  const parse = bytes => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('native_activation_receipt_invalid'); }
  };
  const check = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
      fail('native_activation_receipt_invalid');
    }
  };
  const commit = parse(commitBytes);
  const cleared = parse(clearedBytes);
  check(commit, [...TERMINAL_KEYS].sort());
  check(cleared, CLEARED_KEYS);
  const SHA = /^[a-f0-9]{64}$/u;
  const IDENTITY = /^(?:nna|data)_[a-f0-9]{64}$/u;
  if (commit.protocol !== '1.0' || commit.state !== 'terminal_committed_barred'
    || cleared.state !== 'barriers_cleared_admission_barred'
    || commit.operation_id !== operationId || cleared.operation_id !== operationId
    || commit.stage_operation_id !== stageOperationId || cleared.stage_operation_id !== stageOperationId
    || commit.generation !== generation || cleared.generation !== generation
    || !IDENTITY.test(commit.installation_id) || commit.installation_id !== runtime.installation_id
    || commit.data_id !== runtime.data_id || cleared.installation_id !== runtime.installation_id
    || cleared.data_id !== runtime.data_id
    || ![commit.plan_sha256, commit.decision_sha256, commit.completion_sha256, commit.marker_sha256,
      commit.registration_revision, commit.discovery_sha256, cleared.terminal_sha256,
      cleared.plan_sha256, cleared.decision_sha256, cleared.completion_sha256, cleared.marker_sha256,
      cleared.registration_revision, cleared.discovery_sha256].every(value => SHA.test(value))
    || compileHash(commitBytes) !== cleared.terminal_sha256) fail('native_activation_receipt_invalid');
  return commit;
}

function verifyActiveRegistration(runtime, commit) {
  const recordBytes = readBoundedFile(join(runtime.dataRoot, 'config', 'nnd-package.json'), 16384);
  let record;
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(recordBytes)); }
  catch { fail('native_activation_registration_mismatch'); }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== 'protocol,root,version'
    || record.protocol !== '1.0' || compileHash(recordBytes) !== commit.registration_revision
    || typeof record.root !== 'string' || !pathRooted(record.root)) fail('native_activation_registration_mismatch');
  return record;
}

function pathRooted(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('/') || value.charCodeAt(0) === 92 && value.charCodeAt(1) === 92) return true;
  return /^[A-Za-z]:$/.test(value.slice(0, 2)) && [47, 92].includes(value.charCodeAt(2));
}

function samePath(left, right) {
  return left === right || (process.platform === 'win32' && left.toLowerCase() === right.toLowerCase());
}

async function verifyRetainedController({ child, runtime, readiness, stageOperationId, candidateSha256 }) {
  let status;
  try { status = await packageStatus(runtime); }
  catch { fail('native_activation_status_unavailable'); }
  const commit = verifyRetirementReceipts(runtime, { operationId: readiness.operation_id, stageOperationId,
    generation: readiness.generation });
  const registration = verifyActiveRegistration(runtime, commit);
  if (typeof status.version !== 'string' || !/^\d{8}-[1-9]\d{0,5}$/u.test(status.version)
    || status.version !== registration.version || !samePath(status.root, registration.root)) {
    fail('native_activation_status_version_invalid');
  }
  let attach;
  try {
    attach = await probeNativeAttach({
      installRoot: runtime.root, installation_id: runtime.installation_id, data_id: runtime.data_id });
  } catch { fail('native_activation_attach_unavailable'); }
  if (attach.generation !== readiness.generation || attach.endpoint !== readiness.endpoint
    || attach.installation_id !== runtime.installation_id || attach.data_id !== runtime.data_id) {
    fail('native_activation_attach_changed');
  }
  if (child.exitCode !== null) fail('native_activation_owner_exited');
  return Object.freeze({ ...readiness, root: status.root, version: status.version,
    installation_id: runtime.installation_id, data_id: runtime.data_id, pid: child.pid });
}
if (process.argv[1] && process.argv[1].endsWith('installer-prebuilt-activation.mjs')) {
  if (process.argv.length !== 4) fail('usage: installer-prebuilt-activation.mjs ABSOLUTE_NNA_ROOT STAGE_OPERATION_UUID');
  process.stdout.write(`${JSON.stringify(await activatePrebuiltSlot(process.argv[2], process.argv[3]))}\n`);
}
