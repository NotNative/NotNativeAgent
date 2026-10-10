// SPDX-License-Identifier: Apache-2.0
/** Source-installer fresh path only. Native NNA owns service admission and authority. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSelectedNativeRuntime, validateNativeAttach } from '../packages/electron/native-service-client.mjs';

const execute = promisify(execFile);
const same = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const fail = code => { throw new Error(code); };
export function installerNativeEnvironment(runtime, source = process.env) {
  const env = { ...source, NNA_HOME: runtime.dataRoot };
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NNA_INTEGRATION_TOKEN|NNA_PRINCIPAL|NNA_HARNESS_URL|NNA_NND_.*|NND_.*|NOTNATIVE_.*)$/iu.test(key)) delete env[key];
  }
  return env;
}
async function command(runtime, args, timeout = 30000) {
  try {
    const { stdout } = await execute(runtime.node, [runtime.cli, 'nnd', ...args], {
      cwd: runtime.root, env: installerNativeEnvironment(runtime), windowsHide: true, shell: false,
      timeout, maxBuffer: 8192,
    });
    const value = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('native_response_invalid');
    return value;
  } catch (error) {
    const code = /(?:^|\r?\n)nna: ([a-z][a-z0-9_]{1,100})(?:\r?\n|$)/u.exec(String(error?.stderr ?? ''))?.[1];
    fail(code ?? 'native_command_failed');
  }
}
function selectedRuntime(root, installationId, dataId) {
  const runtime = readSelectedNativeRuntime(root);
  if (runtime.installation_id !== installationId || runtime.data_id !== dataId) fail('native_selection_changed');
  return runtime;
}
async function registered(runtime) {
  const value = await command(runtime, ['package', 'status']);
  if (typeof value.registered !== 'boolean') fail('native_package_status_invalid');
  return value;
}
export async function assertFreshSourceInstall(root, target, installationId, dataId) {
  const runtime = selectedRuntime(root, installationId, dataId);
  if (typeof target !== 'string' || !isAbsolute(target)) fail('fresh_target_invalid');
  const current = await registered(runtime);
  if (current.registered) fail('fresh_registration_exists');
  try { await lstat(target); } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({ state: 'fresh_source_available' });
    throw error;
  }
  fail('fresh_target_exists');
}
function validStatus(status, runtime, version, generation = null) {
  if (status?.protocol !== '1.0' || status.installation_id !== runtime.installation_id
    || status.data_id !== runtime.data_id || !['ready', 'setup_required'].includes(status.service_state)
    || typeof status.instance_id !== 'string' || !/^[a-f0-9-]{36}$/u.test(status.instance_id)
    || generation !== null && status.instance_id !== generation
    || status.package_version !== version || status.package_state !== 'ready'
    || typeof status.endpoint !== 'string'
    || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):(?:[1-9]\d{0,4})$/u.test(status.endpoint)) fail('fresh_service_status_invalid');
  const endpoint = new URL(status.endpoint);
  if (Number(endpoint.port) > 65535) fail('fresh_service_status_invalid');
  return status;
}
async function awaitReadyStatus(runtime, version, initial) {
  // Native startup may legitimately replay sessions for up to 120 seconds;
  // keep installer verification outside that bound without admitting a hang.
  const deadline = Date.now() + 135000;
  let status = initial, generation = null;
  for (;;) {
    if (status?.protocol !== '1.0' || status.installation_id !== runtime.installation_id
      || status.data_id !== runtime.data_id || status.package_version !== version) fail('fresh_service_status_invalid');
    if (generation !== null && status.instance_id !== generation) fail('fresh_service_changed');
    generation = status.instance_id;
    if (['ready', 'setup_required'].includes(status.service_state)) return validStatus(status, runtime, version, generation);
    if (status.service_state !== 'starting' || Date.now() >= deadline) fail('fresh_service_status_invalid');
    await delay(200);
    status = await command(runtime, ['service', 'status', runtime.root], 20000);
  }
}
async function startFreshService(runtime) {
  try { return await command(runtime, ['service', 'start', runtime.root], 150000); }
  catch (error) {
    // A cold Windows launch can fail before discovery is published. NNA owns
    // singleton admission; one retry may start only after that failed owner exits.
    if (error.message !== 'nnd_service_crashed') throw error;
    await delay(500);
    return command(runtime, ['service', 'start', runtime.root], 150000);
  }
}
async function boundedBody(response, limit = 4096) {
  const reader = response.body?.getReader();
  if (!reader) fail('fresh_ui_response_invalid');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) fail('fresh_ui_response_invalid');
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail('fresh_ui_response_invalid'); }
}
async function verifyBootstrap(attach) {
  const origin = attach.origin, url = `${origin}/auth/native-bootstrap`;
  const request = { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: attach.ticket }) };
  const first = await fetch(url, request);
  if (first.status !== 200 || first.redirected || first.url !== url) fail('fresh_ui_bootstrap_invalid');
  const cookie = first.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie || !/^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/u.test(cookie)
    || (await boundedBody(first))?.authenticated !== true) fail('fresh_ui_bootstrap_invalid');
  const sessionUrl = `${origin}/auth/session`;
  const session = await fetch(sessionUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { cookie } });
  if (session.status !== 200 || session.redirected || session.url !== sessionUrl
    || (await boundedBody(session))?.authenticated !== true) fail('fresh_ui_session_invalid');
  const isolated = await fetch(sessionUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (isolated.status !== 401 || (await boundedBody(isolated))?.authenticated !== false) fail('fresh_browser_isolation_invalid');
  const replay = await fetch(url, { ...request, signal: AbortSignal.timeout(5000) });
  if (replay.status !== 401) fail('fresh_ui_ticket_replay_allowed');
  await replay.body?.cancel();
}
export async function verifyFreshSourceService(root, target, installationId, dataId) {
  const runtime = selectedRuntime(root, installationId, dataId);
  const canonicalTarget = await realpath(target);
  const current = await registered(runtime);
  if (!current.registered || current.valid !== true || !same(current.root, canonicalTarget)
    || typeof current.version !== 'string' || !/^\d{8}-[1-9]\d{0,5}$/u.test(current.version)) fail('fresh_registration_invalid');
  const started = await startFreshService(runtime);
  const status = await awaitReadyStatus(runtime, current.version, started);
  const attachment = validateNativeAttach(await command(runtime, ['service', 'attach', runtime.root]), runtime);
  if (attachment.generation !== status.instance_id || attachment.origin !== status.endpoint) fail('fresh_service_attach_invalid');
  await verifyBootstrap(attachment);
  const final = validStatus(await command(runtime, ['service', 'status', runtime.root]),
    runtime, current.version, status.instance_id);
  if (final.endpoint !== status.endpoint) fail('fresh_service_changed');
  const selected = await registered(runtime);
  if (!selected.registered || selected.valid !== true || !same(selected.root, canonicalTarget)
    || selected.version !== current.version) fail('fresh_registration_changed');
  return Object.freeze({ state: 'fresh_service_verified', installation_id: runtime.installation_id,
    data_id: runtime.data_id, generation: final.instance_id, endpoint: final.endpoint,
    service_state: final.service_state, version: current.version });
}

/** Upgrade completion without a service start: the previous install was not
 * running, so the NNA-shaped contract keeps it stopped. Registration and
 * package validity are verified; an unexpectedly running service fails. */
export async function verifyUpgradedStoppedService(root, target, installationId, dataId) {
  const runtime = selectedRuntime(root, installationId, dataId);
  const canonicalTarget = await realpath(target);
  const current = await registered(runtime);
  if (!current.registered || current.valid !== true || !same(current.root, canonicalTarget)
    || typeof current.version !== 'string' || !/^\d{8}-[1-9]\d{0,5}$/u.test(current.version)) fail('fresh_registration_invalid');
  try {
    await command(runtime, ['service', 'status', runtime.root]);
    fail('upgrade_service_started_unexpectedly');
  } catch (error) {
    if (error.message !== 'nnd_service_not_running') throw error;
  }
  return Object.freeze({ state: 'upgrade_registered_stopped', installation_id: runtime.installation_id,
    data_id: runtime.data_id, version: current.version, service_state: 'stopped' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, target, installationId, dataId] = process.argv.slice(2);
  try {
    if (process.argv.length !== 7 || !['preflight', 'verify', 'verify-stopped'].includes(mode)) fail('fresh_usage_invalid');
    const result = mode === 'preflight'
      ? await assertFreshSourceInstall(root, target, installationId, dataId)
      : mode === 'verify'
        ? await verifyFreshSourceService(root, target, installationId, dataId)
        : await verifyUpgradedStoppedService(root, target, installationId, dataId);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`nnd: ${error?.message?.match(/^[a-z][a-z0-9_]{1,100}$/u)?.[0] ?? 'fresh_install_unverified'}\n`);
    process.exitCode = 1;
  }
}
