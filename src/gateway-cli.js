// SPDX-License-Identifier: Apache-2.0
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { loadEffectiveStartupConfiguration, runtimeHookRoots, runtimeSkillRoots } from './startup-configuration.js';
import {
  gatewayPublicStatus, gatewayToken, loadGatewayConfig, normalizeUserId, saveGatewayConfig,
} from './gateway/config.js';
import { TelegramApi } from './gateway/telegram-api.js';
import { TelegramGateway } from './gateway/telegram.js';
import { SessionLock } from './persistence/session-lock.js';
import { ProcessIdentity, validIdentity } from './reliability/process-identity.js';
import { persistAtomicJson } from './persistence/atomic-json.js';

const MAX_TOKEN_BYTES = 1_024;

export async function runGatewayCommand(args, paths, options = {}) {
  const action = args[0] ?? 'status';
  const config = await loadGatewayConfig(paths.gatewayConfig);
  if (action === 'status') return { ...gatewayPublicStatus(config), runtime: await runtimeStatus(paths, options) };
  if (action === 'token') return update(config, paths, { token: required(args[1], 'telegram token'), enabled: config.enabled });
  if (action === 'token-stdin') return update(config, paths, { token: await readToken(options.input), enabled: config.enabled });
  if (action === 'token-env') return update(config, paths, { token_env: required(args[1], 'token environment name'), token: null });
  if (action === 'authorize') return update(config, paths, { authorized_user_ids: [...config.authorized_user_ids, normalizeUserId(args[1])] });
  if (action === 'revoke') return update(config, paths, { authorized_user_ids: config.authorized_user_ids.filter((id) => id !== normalizeUserId(args[1])) });
  if (action === 'workspace') return update(config, paths, { workspace_root: resolve(required(args.slice(1).join(' '), 'workspace path')) });
  if (action === 'enable' || action === 'disable') return update(config, paths, { enabled: action === 'enable' });
  if (action === 'test') return testGateway(config, options);
  if (action === 'run') return runForeground(config, paths, options);
  if (action === 'start') return startDetached(config, paths, options);
  if (action === 'stop') return stopGateway(paths, options);
  throw Object.assign(new Error('invalid gateway command'), { code: 'invalid_gateway_command' });
}

async function update(config, paths, changes) {
  const saved = await saveGatewayConfig(paths.gatewayConfig, { ...config, ...changes, updated_at: new Date().toISOString() });
  return { config: gatewayPublicStatus(saved) };
}

async function testGateway(config, options) {
  const token = gatewayToken(config, options.environment).value;
  const bot = await new TelegramApi(token, { fetch: options.fetch }).getMe();
  return { ok: true, bot: { id: bot.id, username: bot.username ?? null } };
}

async function runForeground(config, paths, options) {
  assertRunnable(config, options.environment);
  const token = gatewayToken(config, options.environment).value;
  const workspaceRoot = config.workspace_root ?? process.cwd();
  const effective = await loadEffectiveStartupConfiguration({
    paths, input: process.stdin, output: process.stderr, diagnostics: process.stderr,
    workspaceRoot, securityAudit: () => undefined,
  });
  const engineConfig = Object.freeze({ ...effective.config, workspaceRoot });
  await writePid(paths, process.pid);
  const gateway = new TelegramGateway({
    api: new TelegramApi(token, { fetch: options.fetch }), config, engineConfig, paths,
    engineOptions: {
      dataPaths: paths, webSearchConfigPath: paths.webSearchConfig, webFetchConfigPath: paths.webFetchConfig,
      hookRoots: runtimeHookRoots(paths, effective.project), skillRoots: runtimeSkillRoots(paths, effective.project),
      ...options.engineOptions,
    },
  });
  let shutdown = null;
  const stop = () => {
    shutdown ??= gateway.shutdown().catch((error) => {
      process.exitCode = 1; process.stderr.write(gatewayShutdownDiagnostic(error));
    });
    return shutdown;
  };
  const signalStop = () => { void stop(); };
  process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop);
  try { return await gateway.run(); }
  finally {
    process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
    await stop();
    await unlink(pidPath(paths)).catch(() => undefined);
  }
}

export function gatewayShutdownDiagnostic(error) {
  const value = typeof error?.code === 'string' ? error.code : 'gateway_shutdown_failed';
  const code = value.trim().replace(/[^A-Za-z0-9_.:@/-]+/gu, '_').slice(0, 96);
  return `nna gateway: ${/^[A-Za-z0-9]/u.test(code) ? code : 'gateway_shutdown_failed'}\n`;
}

async function startDetached(config, paths, options) {
  assertRunnable(config, options.environment);
  const startLock = new SessionLock(paths.gateway, 'gateway-start');
  try {
    await startLock.acquire();
  } catch (error) {
    if (error?.code !== 'session_locked') throw error;
    return { started: false, reason: 'already_starting', runtime: await runtimeStatus(paths, options) };
  }
  try {
    const status = await runtimeStatus(paths, options);
    if (status.running) return { started: false, reason: 'already_running', runtime: status };
    if (status.stale) await preserveStaleGatewayIdentity(paths);
    return await spawnDetachedGateway(paths, options);
  } finally { await startLock.release(); }
}

async function spawnDetachedGateway(paths, options) {
  const log = await open(join(paths.logs, 'gateway-console.log'), 'a');
  const child = (options.spawnProcess ?? spawn)(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1], 'gateway', 'run'], {
    detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, NNA_HOME: paths.root },
  });
  try { await childStarted(child); await writePid(paths, child.pid, options); }
  catch (error) { child.kill?.(); throw error; }
  finally { await log.close(); }
  child.unref();
  return { started: true, pid: child.pid };
}

function childStarted(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.removeListener('spawn', started); child.removeListener('error', failed); };
    const started = () => {
      cleanup();
      if (Number.isSafeInteger(child.pid) && child.pid > 0) resolve();
      else reject(Object.assign(new Error('gateway process did not provide a pid'), { code: 'gateway_start_failed' }));
    };
    const failed = () => {
      cleanup();
      reject(Object.assign(new Error('gateway process could not start'), { code: 'gateway_start_failed' }));
    };
    child.once('spawn', started); child.once('error', failed);
  });
}

async function stopGateway(paths, options) {
  const status = await runtimeStatus(paths, options);
  if (!status.running) return { stopped: false, reason: 'not_running' };
  if (!status.verified) throw Object.assign(new Error('gateway process identity could not be verified'), { code: 'gateway_identity_unverifiable' });
  (options.kill ?? process.kill)(status.pid, 'SIGTERM');
  return { stopped: true, pid: status.pid };
}

export async function runtimeStatus(paths, options = {}) {
  let record;
  try { record = parsePidRecord(await readFile(pidPath(paths), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { running: false }; throw error; }
  if (!record) return { running: false, stale: true };
  const identity = options.processIdentity ?? new ProcessIdentity();
  if (!validIdentity(record.process_identity)) {
    return identity.live(record.pid) ? { running: true, verified: false, pid: record.pid, legacy: true }
      : { running: false, stale: true, pid: record.pid };
  }
  const comparison = await identity.compare(record.process_identity);
  if (comparison === 'same') return { running: true, verified: true, pid: record.pid };
  if (comparison === 'unknown') return { running: true, verified: false, pid: record.pid };
  return { running: false, stale: true, pid: record.pid, reason: comparison };
}

function assertRunnable(config, environment) {
  if (!config.enabled) throw Object.assign(new Error('gateway is disabled'), { code: 'gateway_disabled' });
  if (!gatewayToken(config, environment).value) throw Object.assign(new Error('Telegram token is missing'), { code: 'telegram_token_missing' });
  if (config.authorized_user_ids.length === 0) throw Object.assign(new Error('no Telegram users are authorized'), { code: 'gateway_authorization_required' });
}
async function writePid(paths, pid, options) {
  const identity = options.processIdentity ?? new ProcessIdentity();
  const captured = await identity.capture(pid);
  if (!captured?.start_id) throw Object.assign(new Error('gateway process identity unavailable'), { code: 'gateway_identity_unavailable' });
  await persistAtomicJson(pidPath(paths), { version: 2, pid, process_identity: captured });
}
async function preserveStaleGatewayIdentity(paths) {
  await rename(pidPath(paths), `${pidPath(paths)}.stale.${Date.now()}.${randomUUID()}`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
function parsePidRecord(text) {
  try {
    const value = JSON.parse(text);
    if (Number.isSafeInteger(value) && value > 0) return { version: 1, pid: value };
    return value?.version === 2 && Number.isSafeInteger(value.pid) && value.pid > 0 ? value : null;
  } catch {
    const pid = Number(text.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? { version: 1, pid } : null;
  }
}
function pidPath(paths) { return join(paths.gateway, 'gateway.pid'); }
function required(value, label) { if (!value) throw Object.assign(new Error(`${label} required`), { code: 'gateway_value_required' }); return value; }
async function readToken(input) {
  if (!input) throw Object.assign(new Error('token input required'), { code: 'gateway_value_required' });
  let value = '';
  let bytes = 0;
  for await (const chunk of input) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_TOKEN_BYTES) throw Object.assign(new Error('token input too large'), { code: 'telegram_token_invalid' });
    value += text;
  }
  return required(value.trim(), 'telegram token');
}
