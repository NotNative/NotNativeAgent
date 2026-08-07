// SPDX-License-Identifier: Apache-2.0
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { loadEffectiveStartupConfiguration, runtimeHookRoots, runtimeSkillRoots } from './startup-configuration.js';
import {
  gatewayPublicStatus, gatewayToken, loadGatewayConfig, normalizeUserId, saveGatewayConfig,
} from './gateway-config.js';
import { TelegramApi } from './telegram-api.js';
import { TelegramGateway } from './telegram-gateway.js';

export async function runGatewayCommand(args, paths, options = {}) {
  const action = args[0] ?? 'status';
  const config = await loadGatewayConfig(paths.gatewayConfig);
  if (action === 'status') return { ...gatewayPublicStatus(config), runtime: await runtimeStatus(paths) };
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
  const stop = () => gateway.shutdown().catch(() => undefined);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { return await gateway.run(); }
  finally { await unlink(pidPath(paths)).catch(() => undefined); }
}

async function startDetached(config, paths, options) {
  assertRunnable(config, options.environment);
  const status = await runtimeStatus(paths);
  if (status.running) return { started: false, reason: 'already_running', runtime: status };
  const log = await open(join(paths.logs, 'gateway-console.log'), 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1], 'gateway', 'run'], {
    detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, NNA_HOME: paths.root },
  });
  await writePid(paths, child.pid);
  child.unref();
  await log.close();
  return { started: true, pid: child.pid };
}

async function stopGateway(paths, options) {
  const status = await runtimeStatus(paths);
  if (!status.running) return { stopped: false, reason: 'not_running' };
  (options.kill ?? process.kill)(status.pid, 'SIGTERM');
  return { stopped: true, pid: status.pid };
}

export async function runtimeStatus(paths) {
  let pid;
  try { pid = Number((await readFile(pidPath(paths), 'utf8')).trim()); }
  catch (error) { if (error.code === 'ENOENT') return { running: false }; throw error; }
  if (!Number.isSafeInteger(pid) || pid < 1) return { running: false, stale: true };
  try { process.kill(pid, 0); return { running: true, pid }; }
  catch { return { running: false, stale: true, pid }; }
}

function assertRunnable(config, environment) {
  if (!config.enabled) throw Object.assign(new Error('gateway is disabled'), { code: 'gateway_disabled' });
  if (!gatewayToken(config, environment).value) throw Object.assign(new Error('Telegram token is missing'), { code: 'telegram_token_missing' });
  if (config.authorized_user_ids.length === 0) throw Object.assign(new Error('no Telegram users are authorized'), { code: 'gateway_authorization_required' });
}
async function writePid(paths, pid) { await writeFile(pidPath(paths), `${pid}\n`, { mode: 0o600 }); }
function pidPath(paths) { return join(paths.gateway, 'gateway.pid'); }
function required(value, label) { if (!value) throw Object.assign(new Error(`${label} required`), { code: 'gateway_value_required' }); return value; }
async function readToken(input) {
  if (!input) throw Object.assign(new Error('token input required'), { code: 'gateway_value_required' });
  let value = '';
  for await (const chunk of input) {
    value += chunk.toString('utf8');
    if (Buffer.byteLength(value) > 1024) throw Object.assign(new Error('token input too large'), { code: 'telegram_token_invalid' });
  }
  return required(value.trim(), 'telegram token');
}
