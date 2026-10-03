// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalDirectory, readBoundedJson, readBoundedText } from './native-service-selection.mjs';

const execute = promisify(execFile);
const key = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const digest = (value) => createHash('sha256').update(key(value)).digest('hex');
function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function regularFile(file, root) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('native-install-invalid');
  const real = realpathSync(file);
  if (!statSync(real).isFile() || (root && !contained(root, real))) throw new Error('native-install-invalid');
  return real;
}
export function readSelectedNativeRuntime(selected) {
  const root = canonicalDirectory(selected);
  const descriptor = readBoundedJson(regularFile(path.join(root, 'install.json'), root));
  if (descriptor.product !== 'NotNativeAgent' || !/^\d{8}-[1-9]\d*$/u.test(descriptor.version)
    || key(canonicalDirectory(descriptor.install_root)) !== key(root) || !Number.isInteger(descriptor.node_major)
    || descriptor.node_major < 24) throw new Error('native-install-invalid');
  const data = canonicalDirectory(descriptor.data_root);
  if (contained(root, data)) throw new Error('native-install-invalid');
  const payload = canonicalDirectory(path.join(root, 'installed'));
  if (!contained(root, payload) || key(root) === key(payload)) throw new Error('native-install-invalid');
  const cli = regularFile(path.join(payload, 'src', 'cli.js'), payload);
  const metadata = readBoundedJson(regularFile(path.join(payload, 'package.json'), payload));
  const version = readBoundedText(regularFile(path.join(payload, 'VERSION'), payload)).trim();
  if (metadata.name !== 'not-native-agent' || metadata.nna_version !== descriptor.version || version !== descriptor.version) throw new Error('native-install-invalid');
  const node = regularFile(descriptor.node);
  if (path.basename(node).toLowerCase() !== 'node.exe') throw new Error('native-install-invalid');
  return Object.freeze({ root, node, cli, nodeMajor: descriptor.node_major, version: descriptor.version, installation_id: `nna_${digest(root)}`, data_id: `data_${digest(data)}` });
}
function environment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$|NNA_HOME$|NNA_INTEGRATION_TOKEN$|NNA_PRINCIPAL$|NNA_HARNESS_URL$|NNA_NND_|NND_|NOTNATIVE_)/iu.test(name)));
}
async function command(runtime, action, timeout = 30000) {
  try {
    const { stdout } = await execute(runtime.node, [runtime.cli, 'nnd', 'service', action, runtime.root], {
      cwd: runtime.root, windowsHide: true, shell: false, timeout, maxBuffer: 65536, env: environment(),
    });
    return JSON.parse(stdout);
  } catch (error) {
    const code = /^nna: ([a-z][a-z0-9_]{1,100})\s*$/u.exec(String(error?.stderr ?? ''))?.[1];
    throw new Error(code ?? 'native-command-failed');
  }
}
async function verifySelectedNode(runtime) {
  try {
    const { stdout } = await execute(runtime.node, ['-p',
      'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'],
    { windowsHide: true, shell: false, timeout: 3000, maxBuffer: 4096, env: environment() });
    const value = JSON.parse(stdout);
    if (value.platform !== 'win32' || !['x64','arm64'].includes(value.arch)
      || Number(value.version?.split('.')[0]) !== runtime.nodeMajor) throw new Error();
  } catch { throw new Error('native-runtime-incompatible'); }
}
function identityMatches(value, runtime) {
  return value?.protocol === '1.0' && value.installation_id === runtime.installation_id && value.data_id === runtime.data_id;
}
export function validateNativeAttach(value, runtime) {
  if (!identityMatches(value, runtime) || Object.keys(value).sort().join(',') !==
    'data_id,endpoint,expires_at,generation,installation_id,protocol,ticket'
    || typeof value.generation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.generation)
    || typeof value.endpoint !== 'string' || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/u.test(value.endpoint)
    || typeof value.expires_at !== 'string' || typeof value.ticket !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/u.test(value.ticket)) throw new Error('native-attach-invalid');
  const url = new URL(value.endpoint);
  const expiry = Date.parse(value.expires_at);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 61000) throw new Error('native-attach-expired');
  return { ...value, origin: url.origin };
}
export async function attachNativeService(selection) {
  const selectedRoot = typeof selection === 'string' ? selection : selection?.installRoot;
  const runtime = readSelectedNativeRuntime(selectedRoot);
  if (typeof selection === 'object' && (selection.installation_id !== runtime.installation_id
    || selection.data_id !== runtime.data_id)) throw new Error('native-selection-identity-changed');
  await verifySelectedNode(runtime);
  const capabilities = await command(runtime, 'capabilities');
  if (!identityMatches(capabilities, runtime) || capabilities.native_version !== runtime.version
    || !Array.isArray(capabilities.capabilities) || !Array.isArray(capabilities.commands)
    || !['service_supervision', 'setup_control_plane', 'atomic_ui_attach', 'installer_guard'].every(item => capabilities.capabilities.includes(item))
    || !['start', 'status', 'stop', 'attach', 'install-guard'].every(item => capabilities.commands.includes(item))) {
    throw new Error('native-service-upgrade-required');
  }
  let attached;
  try { attached = await awaitNativeAttach(runtime); }
  catch (error) {
    if (error.message !== 'nnd_service_not_running') throw error;
    await command(runtime, 'start');
    attached = await awaitNativeAttach(runtime);
  }
  return validateNativeAttach(attached, runtime);
}
async function awaitNativeAttach(runtime) {
  const deadline = Date.now() + 25000;
  for (;;) {
    try { return await command(runtime, 'attach', 5000); }
    catch (error) {
      if (error.message !== 'nnd_health_unavailable' || Date.now() >= deadline) throw error;
      await delay(200);
    }
  }
}
/** The returned object never contains the ticket or cookies. Chromium owns its private cookie jar. */
export async function redeemNativeAttachment(attachment, appSession) {
  const response = await appSession.fetch(`${attachment.origin}/auth/native-bootstrap`, {
    method: 'POST', redirect: 'error', credentials: 'include', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Origin: attachment.origin }, body: JSON.stringify({ ticket: attachment.ticket }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('native-ui-authentication-failed'); }
  const text = await boundedResponse(response);
  if (JSON.parse(text)?.authenticated !== true) throw new Error('native-ui-authentication-failed');
  return Object.freeze({ origin: attachment.origin, generation: attachment.generation,
    installationId: attachment.installation_id, dataId: attachment.data_id });
}
async function boundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('native-ui-authentication-failed');
  let bytes = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) { await reader.cancel(); throw new Error('native-ui-authentication-failed'); }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}
