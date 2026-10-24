// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync } from './scratch.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter, getEventListeners } from 'node:events';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatewayPublicStatus, gatewayToken, loadGatewayConfig, normalizeGatewayConfig, saveGatewayConfig,
} from '../src/gateway/config.js';
import { splitTelegramText, TelegramApi, telegramRetryDelayMs } from '../src/gateway/telegram-api.js';
import { gatewayCompactionMessage, gatewaySessionId, TelegramGateway } from '../src/gateway/telegram.js';
import { drainGatewayNotifications } from '../src/gateway/telegram-notifications.js';
import { AttachedReplayState, loadGatewayState } from '../src/gateway/attached-replay.js';
import { runGatewayContextAction } from '../src/gateway/context-actions.js';
import { ConsoleSessionBroker, ConsoleSessionDirectory } from '../src/session-broker.js';
import { readTelegramOutbox, reconcileTelegramNotifications, TelegramNotificationQueue } from '../src/notifications/telegram.js';
import { JournalStore } from '../src/store.js';
import { commandDefinition } from '../src/tui/commands.js';
import { configOverlay, gatewayOverlay, overlayCommandDraft } from '../src/tui/overlays.js';
import { gatewayShutdownDiagnostic, runGatewayCommand, runtimeStatus } from '../src/gateway-cli.js';
import { handleGatewayCommand } from '../src/tui/gateway-command.js';
import { SecretBroker } from '../src/secret-broker.js';
import { SessionLock } from '../src/persistence/session-lock.js';
import { submitWorkspaceSession } from '../src/experience/session-broker.js';
import { acceptPendingSubmission } from '../src/experience/submission.js';
import { SessionEngine } from '../src/engine.js';

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* State may not be published yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not settle before deadline');
}

function pendingUntilAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('gateway refuses malformed or unsupported durable replay state without resetting its offset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-corrupt-state-'));
  const statePath = join(root, 'state.json');
  assert.deepEqual(await loadGatewayState(statePath), { offset: 0, inbox: [], routes: {}, replies: [], operations: {}, suppressed: {}, attachments: {} });
  for (const state of ['{', JSON.stringify({ version: 4, offset: 8, inbox: [] }),
    JSON.stringify({ version: 3, offset: 8, inbox: [], attachments: {}, routes: {}, replies: [null] }),
    'x'.repeat(1_048_577)]) {
    await writeFile(statePath, state);
    await assert.rejects(loadGatewayState(statePath), { code: 'gateway_state_invalid' });
    assert.equal(await readFile(statePath, 'utf8'), state);
  }
  await rm(root, { recursive: true, force: true });
});

test('v2 pending gateway updates cannot migrate without their memory-only attachment route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-v2-route-'));
  const statePath = join(root, 'state.json');
  const update = { update_id: 7, message: { text: 'send to attached Console', from: { id: 42 }, chat: { id: 42 } } };
  const legacy = JSON.stringify({ version: 2, offset: 8, inbox: [update] });
  await writeFile(statePath, legacy);
  await assert.rejects(loadGatewayState(statePath), { code: 'gateway_route_unrecoverable' });
  assert.equal(await readFile(statePath, 'utf8'), legacy);
  await writeFile(statePath, JSON.stringify({ version: 2, offset: 8, inbox: [] }));
  assert.deepEqual(await loadGatewayState(statePath), { offset: 8, inbox: [], routes: {}, replies: [], operations: {}, suppressed: {}, attachments: {} });
  const pendingControl = JSON.stringify({ version: 3, offset: 8, inbox: [
    { update_id: 7, message: { text: '/handoff', from: { id: 42 }, chat: { id: 42 } } }],
    attachments: {}, routes: {}, replies: [] });
  await writeFile(statePath, pendingControl);
  await assert.rejects(loadGatewayState(statePath), { code: 'gateway_control_replay_unrecoverable' });
  assert.equal(await readFile(statePath, 'utf8'), pendingControl);
  await rm(root, { recursive: true, force: true });
});

test('attached-only gateway shutdown waits for outstanding durable writes after polling stops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-shutdown-write-'));
  let releaseWrite;
  const write = new Promise((resolve) => { releaseWrite = resolve; });
  const gateway = new TelegramGateway({
    api: {}, config: { authorized_user_ids: [] },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs') },
    logger: { record() {}, async flush() {} },
  });
  gateway.stateWrites = write;
  let settled = false;
  const shutdown = gateway.shutdown().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseWrite();
  await shutdown;
  assert.equal(settled, true);
  await gateway.shutdown();
  await rm(root, { recursive: true, force: true });
});

test('failed gateway state persistence stops polling and still closes engines and logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-write-failure-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs') };
  let gateway; let polls = 0; let stopped = 0; let flushed = 0; const events = [];
  const api = {
    async getMe() {
      // A directory at the state-file path makes the first durable write fail.
      await mkdir(gateway.statePath);
      gateway.sessions.set('existing', {
        ingress: { async submit() { return { accepted: true }; } },
        engine: { async shutdown() { stopped += 1; } },
      });
      return { id: 1 };
    },
    async getUpdates() {
      polls += 1;
      return [{ update_id: 1, message: { text: 'hello', from: { id: 42 }, chat: { id: 42 } } }];
    },
  };
  gateway = new TelegramGateway({ api, paths,
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    logger: { async initialize() {}, record(event) { events.push(event); }, async flush() { flushed += 1; } },
  });
  await assert.rejects(gateway.run());
  assert.equal(polls, 1);
  assert.equal(stopped, 1);
  assert.equal(flushed, 1);
  assert.equal(gateway.running, false);
  assert.equal(gateway.controller.signal.aborted, true);
  await assert.rejects(gateway.shutdown());
  assert.equal(events.find((event) => event.type === 'gateway_stopped')?.status, 'failed');
  await assert.rejects(gateway.replay.queueReply(1, '42', '42', 'reply', ''), { code: 'gateway_state_write_failed' });
  await rm(root, { recursive: true, force: true });
});

test('late Telegram poll response cannot admit updates after gateway shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-late-poll-'));
  let releasePoll; let polling;
  const enteredPoll = new Promise((resolve) => { polling = resolve; });
  const heldPoll = new Promise((resolve) => { releasePoll = resolve; });
  const gateway = new TelegramGateway({
    api: {
      async getMe() { return { id: 1 }; },
      async getUpdates() { polling(); return heldPoll; },
    },
    paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs') },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    logger: { async initialize() {}, record() {}, async flush() {} },
  });
  const running = gateway.run();
  await enteredPoll;
  await gateway.shutdown();
  releasePoll([{ update_id: 1, message: { text: 'late', from: { id: 42 }, chat: { id: 42 } } }]);
  await running;
  assert.equal(gateway.offset, 0);
  assert.deepEqual(gateway.inbox, []);
  await assert.rejects(readFile(gateway.statePath, 'utf8'), { code: 'ENOENT' });
  await rm(root, { recursive: true, force: true });
});

test('gateway shutdown diagnostics expose only a stable code', () => {
  const diagnostic = gatewayShutdownDiagnostic({ code: 'close failed', message: 'private token detail' });
  assert.equal(diagnostic, 'nna gateway: close_failed\n');
  assert.doesNotMatch(diagnostic, /private|token/u);
});

test('gateway compaction notices expose terminal status without context content', () => {
  assert.equal(gatewayCompactionMessage({ type: 'context_compaction_status', status: 'started' }), null);
  assert.match(gatewayCompactionMessage({ type: 'context_compaction_status', status: 'completed',
    before_estimated_tokens: 30000, after_estimated_tokens: 20000 }), /30,000.*20,000/u);
  assert.match(gatewayCompactionMessage({ type: 'context_compaction_status', status: 'skipped' }), /skipped/u);
  assert.match(gatewayCompactionMessage({ type: 'context_compaction_status', status: 'failed',
    reason_code: 'private', content: 'private secret' }), /could not compact/u);
  assert.equal(gatewayCompactionMessage({ type: 'stream_delta', text: 'private' }), null);
});

test('slow Telegram compaction notice does not block the governed turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-compaction-'));
  let releaseNotice; const noticeGate = new Promise((resolve) => { releaseNotice = resolve; });
  let answerSent; const answer = new Promise((resolve) => { answerSent = resolve; });
  let polls = 0;
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      if (++polls === 1) return [{ update_id: 1, message: { text: 'hello', from: { id: 42 }, chat: { id: 42 } } }];
      return pendingUntilAbort(signal);
    },
    async sendMessage(_chatId, text) {
      if (text.startsWith('NNA compacted context:')) return noticeGate;
      if (text === 'finished') answerSent();
    },
  };
  const gateway = new TelegramGateway({
    api, paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer') },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineFactory: ({ output }) => ({
      config: { executionManifest: null }, initialize: async () => undefined,
      submit: async () => {
        await output({ type: 'context_compaction_status', status: 'completed',
          before_estimated_tokens: 30_000, after_estimated_tokens: 18_000 });
        return { outcome: 'completed', text: 'finished' };
      },
      cancel: async () => ({ accepted: true }), shutdown: async () => ({ complete: true }),
    }),
  });
  const running = gateway.run();
  try { await answer; }
  finally { releaseNotice(); await gateway.shutdown(); await running; }
});

test('gateway config is absent-safe, bounded, durable, and redacted', async t => {
  const root = createScratchSync('nna-gateway-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config', 'gateway.json');
  assert.equal((await loadGatewayConfig(path)).enabled, false);
  const config = await saveGatewayConfig(path, {
    enabled: true, token: 'TEST_FIXTURE_NOT_A_REAL_TELEGRAM_TOKEN',
    authorized_user_ids: ['42', '42', 7], workspace_root: root,
  });
  assert.deepEqual(config.authorized_user_ids, ['42', '7']);
  assert.equal(gatewayToken(config, {}).source, 'restricted local config');
  assert.equal(gatewayPublicStatus(config, {}).configured, true);
  assert.equal(Object.hasOwn(gatewayPublicStatus(config, {}), 'token'), false);
  assert.match(await readFile(path, 'utf8'), /authorized_user_ids/u);
  assert.throws(() => normalizeGatewayConfig({ authorized_user_ids: ['nope'] }), { code: 'telegram_user_id_invalid' });
});

test('environment Telegram token takes precedence without entering public status', () => {
  const config = normalizeGatewayConfig({
    token: 'TEST_FIXTURE_NOT_A_REAL_TELEGRAM_TOKEN', token_env: 'BOT_TOKEN', authorized_user_ids: [],
  });
  assert.deepEqual(gatewayToken(config, { BOT_TOKEN: 'environment-secret-token-value' }), {
    value: 'environment-secret-token-value', source: 'BOT_TOKEN',
  });
  assert.equal(JSON.stringify(gatewayPublicStatus(config, { BOT_TOKEN: 'environment-secret-token-value' })).includes('environment-secret'), false);
});

test('Telegram transport uses bounded POST requests and chunks replies', async () => {
  const calls = [];
  const api = new TelegramApi('123:token-value-that-is-long-enough', { fetch: async (url, init) => {
    calls.push({ url, init });
    const result = url.endsWith('/getUpdates') ? [] : { id: 5, username: 'nna_test' };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  } });
  assert.equal((await api.getMe()).username, 'nna_test');
  await api.sendMessage('99', 'a'.repeat(8_300));
  assert.equal(calls.length, 4);
  assert.equal(calls.every((item) => item.init.method === 'POST'), true);
  await api.getUpdates(0, 5);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body).allowed_updates, ['message', 'callback_query']);
  assert.equal(splitTelegramText('a'.repeat(8_300)).length, 3);
  assert.equal(Object.keys(api).includes('baseUrl'), false);
});

test('Telegram transport bounds streamed bodies and never exposes its token through errors', async () => {
  const token = '123:private-telegram-token-value';
  const oversized = new TelegramApi(token, { fetch: async () => new Response(new Uint8Array(1_048_577)) });
  await assert.rejects(oversized.getMe(), { code: 'telegram_response_too_large' });
  const failed = new TelegramApi(token, { fetch: async (url) => { throw new Error(`request failed for ${url}`); } });
  await assert.rejects(failed.getMe(), (error) => {
    assert.equal(error.code, 'telegram_unavailable');
    assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /private-telegram-token-value/u);
    return true;
  });
});

test('Telegram transport rejects URL-shaped tokens and malformed message input', async () => {
  for (const token of ['123:secret/path', '123:secret?mode=send', '123:secret#fragment', '123:secret%2Fpath']) {
    assert.throws(() => new TelegramApi(token), { code: 'telegram_token_invalid' });
  }
  const bodies = [];
  const api = new TelegramApi('123:token-value-that-is-long-enough', { fetch: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  } });
  await api.sendMessage('99', null);
  assert.equal(bodies[0].text, '(NNA returned no text.)');
  await assert.rejects(api.sendMessage('99', { text: 'wrong type' }), { code: 'telegram_message_invalid' });
  assert.equal(bodies.length, 1);
});

test('Telegram response and chunk boundaries preserve typed failures and Unicode', async () => {
  const api = new TelegramApi('fixture', { fetch: async () => new Response('null') });
  await assert.rejects(api.getMe(), { code: 'telegram_response_invalid' });
  const missingResult = new TelegramApi('fixture', { fetch: async () => new Response('{"ok":true,"result":null}') });
  await assert.rejects(missingResult.getUpdates(0), { code: 'telegram_response_invalid' });
  await assert.rejects(missingResult.getMe(), { code: 'telegram_response_invalid' });
  assert.throws(() => splitTelegramText({ length: 1 }), { code: 'telegram_message_invalid' });
  assert.throws(() => splitTelegramText('x', 0), { code: 'telegram_chunk_limit_invalid' });
  assert.throws(() => splitTelegramText('😀', 1), { code: 'telegram_chunk_limit_invalid' });
  assert.deepEqual(splitTelegramText('😀😀', 3), ['😀', '😀']);
});

test('Telegram 429 retry-after is bounded and retained for polling and reply retries', async () => {
  const token = 'fixture';
  const api = new TelegramApi(token, { fetch: async () => new Response(JSON.stringify({
    ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 },
  }), { status: 429 }) });
  let rateLimit;
  await assert.rejects(api.getUpdates(0), (error) => {
    rateLimit = error;
    assert.equal(error.code, 'telegram_api_error');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 7_000);
    assert.equal(telegramRetryDelayMs(error), 7_000);
    return true;
  });
  assert.equal(telegramRetryDelayMs({ code: 'telegram_api_error', retryAfterMs: -1 }), 1_000);
  assert.equal(telegramRetryDelayMs({ code: 'telegram_unavailable', retryAfterMs: 7_000 }), 1_000);
  const oversized = new TelegramApi(token, { fetch: async () => new Response(JSON.stringify({
    ok: false, parameters: { retry_after: 10_000 },
  }), { status: 429 }) });
  await assert.rejects(oversized.getUpdates(0), (error) => {
    assert.equal(error.retryAfterMs, 300_000);
    return true;
  });

  const replay = new AttachedReplayState({
    api: { async sendMessage() { throw rateLimit; } }, controller: new AbortController(),
    config: { authorized_user_ids: ['42'] }, logger: { record() {} },
    inbox: () => [], save: async () => {}, stop() {}, controls: () => ({}), bytes: () => 0,
  });
  replay.replies = [{ updateId: 1, chatId: '42', userId: '42', text: 'queued', alias: '' }];
  const before = Date.now();
  await replay.drain();
  assert.ok(replay.retryAt >= before + 7_000 && replay.retryAt <= Date.now() + 7_000);
  assert.equal(replay.replies.length, 1);
});

test('Telegram polling waits for the rate-limit interval before retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-rate-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let polls = 0;
  let signalFirstPoll;
  const firstPoll = new Promise((resolve) => { signalFirstPoll = resolve; });
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      polls += 1;
      if (polls === 1) {
        signalFirstPoll();
        throw Object.assign(new Error('rate limited'), { code: 'telegram_api_error', retryAfterMs: 7_000 });
      }
      return pendingUntilAbort(signal);
    },
  };
  const gateway = new TelegramGateway({
    api, paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs') },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    config: { authorized_user_ids: [], polling_timeout_seconds: 5 },
    logger: { async initialize() {}, record() {}, async flush() {} },
  });
  const running = gateway.run();
  try {
    await firstPoll;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(polls, 1);
    t.mock.timers.tick(6_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(polls, 1);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(polls, 2);
  } finally { await gateway.shutdown(); await running; }
});

test('gateway session identifiers do not disclose Telegram chat identifiers', () => {
  const id = gatewaySessionId('-100123456789');
  assert.match(id, /^telegram_[a-f0-9]{32}$/u);
  assert.equal(id.includes('123456789'), false);
  assert.equal(id, gatewaySessionId('-100123456789'));
});

test('gateway appears in configuration and exposes actionable menu drafts', () => {
  assert.equal(commandDefinition('/gateway').name, '/gateway');
  const view = gatewayOverlay({
    enabled: false, configured: false, token_source: null, authorized_user_ids: [],
    workspace_root: null, runtime: { running: false },
  });
  assert.equal(view.kind, 'gateway');
  assert.equal(overlayCommandDraft('gateway', 'action:authorize'), '/gateway authorize ');
  const hub = configOverlay({
    workspaceRoot: 'D:\\repo', routes: { primary: { providerId: 'local', model: 'qwen' } },
    providerProfiles: { local: {} }, mcpServers: [],
  });
  assert.equal(hub.items.some((item) => item.id === 'gateway'), true);
});

test('TUI gateway commands exclude secret and foreground actions and enforce arity', async () => {
  const calls = [];
  const workspace = {
    gatewayCommand: async (args) => { calls.push(args); return { running: false }; },
    projection: { openOverlay: () => undefined },
  };
  for (const command of ['run', 'token private', 'status extra', 'authorize', 'authorize not-a-user']) {
    await assert.rejects(handleGatewayCommand(command, workspace), { code: 'gateway_tui_command_invalid' });
  }
  await handleGatewayCommand('authorize 42', workspace);
  assert.deepEqual(calls[0], ['authorize', '42']);
});

test('gateway start failure is reported without publishing a false pid', async t => {
  const root = createScratchSync('nna-gateway-start-failure-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    root, gateway: join(root, 'gateway'), logs: join(root, 'logs'),
    gatewayConfig: join(root, 'gateway', 'config.json'),
  };
  await mkdir(paths.logs, { recursive: true });
  await saveGatewayConfig(paths.gatewayConfig, {
    enabled: true, token: 'TEST_FIXTURE_NOT_A_REAL_TELEGRAM_TOKEN', authorized_user_ids: ['42'],
  });
  const child = new EventEmitter();
  child.pid = undefined;
  child.unref = () => undefined;

  await assert.rejects(runGatewayCommand(['start'], paths, {
    environment: {},
    spawnProcess: () => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
      return child;
    },
  }), { code: 'gateway_start_failed' });
  await assert.rejects(readFile(join(paths.gateway, 'gateway.pid')), { code: 'ENOENT' });
});

test('gateway foreground startup publishes its process identity before polling', async () => {
  const root = createScratchSync('nna-gateway-foreground-');
  const paths = {
    root, config: join(root, 'config'), gateway: join(root, 'runtime', 'gateway'),
    logs: join(root, 'logs'), gatewayConfig: join(root, 'config', 'gateway.json'),
    trustedWorkspaces: join(root, 'config', 'trusted-workspaces.json'),
    hooks: join(root, 'hooks'), skills: join(root, 'skills'),
    sessionBrokers: join(root, 'runtime', 'session-brokers'),
    secretVault: join(root, 'secrets', 'vault.json'), secretKey: join(root, 'secrets', 'master-key.json'),
    secretAudit: join(root, 'secrets', 'audit.ndjson'),
  };
  await mkdir(paths.config, { recursive: true });
  await writeFile(join(paths.config, 'manifest.json'), `${JSON.stringify({
    persistence: 'durable',
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' },
  })}\n`);
  await saveGatewayConfig(paths.gatewayConfig, {
    enabled: true, token: 'TEST_FIXTURE_NOT_A_REAL_TELEGRAM_TOKEN',
    authorized_user_ids: ['42'], workspace_root: root,
  });
  const captured = []; const methods = []; let gatewayEngineOptions; let gateway;
  const processIdentity = {
    async capture(pid) {
      captured.push(pid);
      return { version: 1, pid, platform: 'fixture', start_id: 'foreground' };
    },
  };
  const fetch = async (url) => {
    const method = new URL(url).pathname.split('/').at(-1);
    methods.push(method);
    if (method === 'getUpdates') void gateway.shutdown();
    const result = method === 'getMe' ? { id: 1, username: 'fixture' } : [];
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };

  const bot = await runGatewayCommand(['run'], paths, {
    environment: {}, input: null, processIdentity, fetch,
    gatewayFactory: (options) => {
      gatewayEngineOptions = options.engineOptions;
      gateway = new TelegramGateway(options);
      return gateway;
    },
  });
  assert.equal(bot.id, 1);
  assert.deepEqual(captured, [process.pid, process.pid]);
  assert.deepEqual(methods, ['getMe', 'getUpdates']);
  assert.ok(gatewayEngineOptions.secretBroker instanceof SecretBroker);
  assert.equal(gatewayEngineOptions.secretBroker.vault.path, paths.secretVault);
  assert.equal(gatewayEngineOptions.secretBroker.vault.keyPath, paths.secretKey);
  await assert.rejects(readFile(join(paths.gateway, 'gateway.pid')), { code: 'ENOENT' });
});

test('gateway foreground run cannot replace a live gateway owner', async (t) => {
  const root = createScratchSync('nna-gateway-singleton-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { root, config: join(root, 'config'), gateway: join(root, 'runtime', 'gateway'),
    gatewayConfig: join(root, 'config', 'gateway.json') };
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'config', 'manifest.json'), `${JSON.stringify({
    persistence: 'durable',
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' },
  })}\n`);
  await saveGatewayConfig(paths.gatewayConfig, {
    enabled: true, token: 'TEST_FIXTURE_NOT_A_REAL_TELEGRAM_TOKEN', authorized_user_ids: ['42'],
  });
  const identity = {
    capture: async (pid) => ({ version: 1, pid, platform: 'fixture', start_id: 'gateway-owner' }),
    compare: async () => 'same',
  };
  const owner = new SessionLock(paths.gateway, 'gateway-running', { processIdentity: identity });
  await owner.acquire();
  try {
    await assert.rejects(runGatewayCommand(['run'], paths, {
      environment: {}, processIdentity: identity,
      gatewayFactory: () => assert.fail('second gateway must not start'),
    }), { code: 'session_locked' });
    await assert.rejects(readFile(join(paths.gateway, 'gateway.pid')), { code: 'ENOENT' });
  } finally { await owner.release(); }
  const priorRecord = { version: 2, pid: process.pid + 1000,
    process_identity: { version: 1, pid: process.pid + 1000, platform: 'fixture', start_id: 'legacy-owner' } };
  await writeFile(join(paths.gateway, 'gateway.pid'), JSON.stringify(priorRecord));
  await assert.rejects(runGatewayCommand(['run'], paths, {
    environment: {}, processIdentity: identity,
    gatewayFactory: () => assert.fail('live legacy owner must not be replaced'),
  }), { code: 'session_locked' });
  assert.deepEqual(JSON.parse(await readFile(join(paths.gateway, 'gateway.pid'), 'utf8')), priorRecord);
});

test('gateway status and stop require the recorded process instance rather than PID liveness alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-identity-'));
  const paths = { root, gateway: join(root, 'gateway'), gatewayConfig: join(root, 'gateway', 'config.json') };
  await mkdir(paths.gateway, { recursive: true });
  await writeFile(join(paths.gateway, 'gateway.pid'), JSON.stringify({
    version: 2, pid: 44,
    process_identity: { version: 1, pid: 44, platform: 'fixture', start_id: 'original' },
  }));
  const different = { compare: async () => 'different', live: () => true };
  assert.deepEqual(await runtimeStatus(paths, { processIdentity: different }), {
    running: false, stale: true, pid: 44, reason: 'different',
  });
  const killed = [];
  const same = { compare: async () => 'same', live: () => true };
  assert.deepEqual(await runtimeStatus(paths, { processIdentity: same }), { running: true, verified: true, pid: 44 });
  assert.deepEqual(await runGatewayCommand(['stop'], paths, { processIdentity: same, kill: (...args) => killed.push(args) }), {
    stopped: true, pid: 44,
  });
  assert.deepEqual(killed, [[44, 'SIGTERM']]);
  await writeFile(join(paths.gateway, 'gateway.pid'), '44\n');
  await assert.rejects(runGatewayCommand(['stop'], paths, { processIdentity: same, kill: () => assert.fail('must not kill') }), {
    code: 'gateway_identity_unverifiable',
  });
});

test('gateway stop upgrades time-correlated Windows legacy PID evidence before signaling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-legacy-identity-'));
  const paths = { root, gateway: join(root, 'gateway'), gatewayConfig: join(root, 'gateway', 'config.json') };
  await mkdir(paths.gateway, { recursive: true });
  await writeFile(join(paths.gateway, 'gateway.pid'), '44\n');
  const killed = [];
  const identity = {
    live: () => true,
    capture: async () => ({ version: 1, pid: 44, platform: 'win32', start_id: '638000000000000000' }),
    legacyPidFileMatches: () => true,
    compare: async () => 'same',
  };
  assert.deepEqual(await runGatewayCommand(['stop'], paths, { processIdentity: identity, kill: (...args) => killed.push(args) }), {
    stopped: true, pid: 44,
  });
  assert.deepEqual(killed, [[44, 'SIGTERM']]);
  assert.equal(JSON.parse(await readFile(join(paths.gateway, 'gateway.pid'), 'utf8')).version, 2);
});

test('Telegram durably retains queue-full updates and eventually submits each update exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-inbox-'));
  let polls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const updates = Array.from({ length: 17 }, (_, index) => ({
    update_id: index + 1, message: { text: `message-${index + 1}`, from: { id: 42 }, chat: { id: 420 } },
  }));
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      polls += 1;
      if (polls === 1) return updates;
      return pendingUntilAbort(signal);
    },
    async sendMessage() {},
  };
  const submitted = [];
  const logged = [];
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer') };
  const gateway = new TelegramGateway({
    api, paths, engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 32 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    logger: { initialize: async () => {}, record: (event) => { logged.push(event); }, flush: async () => {} },
    engineFactory: () => ({
      config: { executionManifest: null }, initialize: async () => undefined,
      submit: async (command) => { submitted.push(command.request_id); await gate; return { outcome: 'completed', text: 'ok' }; },
      cancel: async () => ({ accepted: true }), shutdown: async () => ({ complete: true }),
    }),
  });
  const running = gateway.run();
  void running.catch(() => undefined);
  try {
    // The second poll starts only after the first batch is durably saved. Read
    // the destination once here; repeated Windows opens can obstruct the
    // gateway's atomic rename while its acknowledgements are being written.
    await waitUntil(() => polls >= 2);
    assert.equal(JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length, 17);
    assert.ok(logged.some((event) => event.type === 'gateway_queue_full' && event.code === 'gateway_chat_queue_full'),
      'The seventeenth update must actually exceed the pending-chat queue');
    release();
    await waitUntil(() => submitted.length === 17);
    await gateway.shutdown(); await running;
    assert.equal(JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length, 0);
    assert.equal(new Set(submitted).size, 17);
    assert.deepEqual(submitted.sort(), updates.map((item) => `gateway_update_${item.update_id}`).sort());
  } finally {
    release();
    // Early assertion failures must not leave the held submission or poll alive.
    await gateway.shutdown().catch(() => undefined);
    await running.catch(() => undefined);
  }
});

test('Telegram stops visibly when one update cannot fit in durable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-oversize-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs') };
  let polls = 0;
  const gateway = new TelegramGateway({
    api: {
      async getMe() { return { id: 1 }; },
      async getUpdates() {
        polls += 1;
        return [{ update_id: 1, message: { text: 'x'.repeat(1_048_576), from: { id: 42 }, chat: { id: 42 } } }];
      },
    },
    paths, config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    logger: { async initialize() {}, record() {}, async flush() {} },
  });
  try {
    await assert.rejects(gateway.run(), { code: 'gateway_state_full' });
    assert.equal(polls, 1);
    assert.equal(gateway.offset, 0);
    assert.deepEqual(gateway.inbox, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Telegram poll retry releases its abort listener after the delay resolves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-poll-delay-'));
  let polls = 0, listenersAfterRetry = null;
  const gateway = new TelegramGateway({
    api: {
      async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        if (++polls === 1) throw Object.assign(new Error('retry'), { code: 'telegram_api_error', retryAfterMs: 1 });
        listenersAfterRetry = getEventListeners(signal, 'abort').length;
        return pendingUntilAbort(signal);
      },
    },
    paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs') },
    config: { authorized_user_ids: [], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    logger: { async initialize() {}, record() {}, async flush() {} },
  });
  const running = gateway.run();
  try {
    await waitUntil(() => polls >= 2);
    assert.equal(listenersAfterRetry, 0);
  } finally {
    await gateway.shutdown();
    await running;
    await rm(root, { recursive: true, force: true });
  }
});

test('authorized Telegram messages enter a durable chat session while unknown users are silent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-runtime-'));
  const sent = [], created = [];
  let polls = 0, sentResolve;
  const messageSent = new Promise((resolve) => { sentResolve = resolve; });
  const api = {
    async getMe() { return { id: 1, username: 'nna_test' }; },
    async getUpdates(_offset, _timeout, signal) {
      polls += 1;
      if (polls === 1) return [
        { update_id: 1, message: { text: 'ignored', from: { id: 7 }, chat: { id: 70 } } },
        { update_id: 2, message: { text: 'hello', from: { id: 42 }, chat: { id: 420 } } },
      ];
      return pendingUntilAbort(signal);
    },
    async sendMessage(chatId, text) { sent.push({ chatId, text }); sentResolve(); },
  };
  const paths = {
    gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'),
  };
  const engineConfig = { limits: { providerConcurrency: 1, providerQueueLimit: 4 } };
  const gateway = new TelegramGateway({
    api, paths, engineConfig,
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineFactory: (options) => {
      created.push(options.sessionId);
      return {
        config: { executionManifest: null }, initialize: async () => undefined,
        submit: async (command, principal) => ({ outcome: 'completed', text: `${principal}:${command.content}` }),
        cancel: async () => ({ accepted: true }), shutdown: async () => ({ complete: true }),
      };
    },
  });
  const running = gateway.run();
  await messageSent;
  await gateway.shutdown();
  await running;
  assert.equal(created.length, 1);
  assert.equal(created[0], gatewaySessionId('420'));
  assert.deepEqual(sent, [{ chatId: '420', text: 'authenticated-telegram-user:42:hello' }]);
});

test('Telegram explains internal maintenance failures without falsely discarding delivered work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-maintenance-failure-'));
  const sent = [];
  let polls = 0; let delivered;
  const done = new Promise((resolve) => { delivered = resolve; });
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      polls += 1;
      if (polls === 1) return [{ update_id: 1, message: { text: 'research this', from: { id: 42 }, chat: { id: 420 } } }];
      return pendingUntilAbort(signal);
    },
    async sendMessage(chatId, text) { sent.push({ chatId, text }); delivered(); },
  };
  const gateway = new TelegramGateway({
    api,
    paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer') },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineFactory: () => ({
      config: { executionManifest: null }, initialize: async () => undefined,
      submit: async () => ({
        outcome: 'failed', text: '', failure: { code: 'invalid_event_phase', category: 'contract' },
      }),
      cancel: async () => ({ accepted: true }), shutdown: async () => ({ complete: true }),
    }),
  });
  const running = gateway.run();
  await done;
  await gateway.shutdown();
  await running;
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /internal session-maintenance error/u);
  assert.match(sent[0].text, /response already received.*conversation was preserved/u);
  assert.doesNotMatch(sent[0].text, /^Turn failed\.$/u);
});

test('Console session broker discovers, submits, and cancels without copying conversation context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-session-broker-'));
  const calls = [];
  const workspace = {
    brokerSessions: () => [{ id: 'session-main', alias: 'Main', summary: 'Working on gateway routing', active: true, busy: false }],
    submitSession: async (id, content, requestId) => { calls.push(['submit', id, content, requestId]); return { outcome: 'completed', text: 'done' }; },
    cancelSession: async (id, expectedTurnId, fenceRequestIds) => {
      calls.push(['cancel', id, expectedTurnId, fenceRequestIds]); return { accepted: true };
    },
    compactSession: async (id) => { calls.push(['compact', id]); return { omitted: 8, retained: 3, reduced: 1 }; },
    handoffSession: async (id) => { calls.push(['handoff', id]); return { omitted: 11, retained: 0 }; },
    clearSession: async (id) => { calls.push(['clear', id]); return { removed: 4, cleared: true }; },
  };
  const broker = await new ConsoleSessionBroker(workspace, { root }).start();
  const directory = new ConsoleSessionDirectory(root);
  try {
    const [target] = await directory.list();
    assert.equal(target.alias, 'Main');
    assert.equal(target.summary, 'Working on gateway routing');
    assert.deepEqual(await directory.submit(target, 'continue here'), { outcome: 'completed', text: 'done' });
    assert.deepEqual(await directory.submit(target, 'retry here', 'gateway_update_17'), { outcome: 'completed', text: 'done' });
    await assert.rejects(directory.submit(target, 'invalid', 'not valid'), { code: 'invalid_id' });
    assert.deepEqual(await directory.cancel(target), { accepted: true });
    assert.deepEqual(await directory.cancel(target, 'turn-A', ['gateway_update_16']), { accepted: true });
    await assert.rejects(directory.cancel(target, undefined, ['other-id']), { code: 'broker_request_invalid' });
    assert.deepEqual(await directory.compact(target), { omitted: 8, retained: 3, reduced: 1 });
    assert.deepEqual(await directory.handoff(target), { omitted: 11, retained: 0 });
    assert.deepEqual(await directory.clear(target), { removed: 4, cleared: true });
    assert.deepEqual(calls, [
      ['submit', 'session-main', 'continue here', undefined],
      ['submit', 'session-main', 'retry here', 'gateway_update_17'], ['cancel', 'session-main', undefined, []],
      ['cancel', 'session-main', 'turn-A', ['gateway_update_16']],
      ['compact', 'session-main'], ['handoff', 'session-main'], ['clear', 'session-main'],
    ]);
  } finally { await broker.close(); }
  assert.deepEqual(await directory.list(), []);
});

test('attached Telegram replay does not duplicate the projected user message', async () => {
  const projected = []; const requests = new Set();
  const session = { id: 'session-main', engine: { transcript: [], state: { state: 'idle' } },
    ingress: { submit: async () => assert.fail('stable request must use idempotent start'), start(command) {
      if (requests.has(command.request_id)) return { duplicate: true, result: { duplicate: true } };
      requests.add(command.request_id);
      acceptPendingSubmission(workspace, session, { type: 'accepted', accepted: true, request_id: command.request_id });
      return { duplicate: false, operation: Promise.resolve({ outcome: 'completed', text: 'done' }) };
    } } };
  const workspace = { sessions: new Map([['session-main', session]]),
    projection: { sessions: new Map([['session-main', { pendingAttachments: [] }]]), apply: (_id, event) => projected.push(event) },
    tabPersistence: { observe() {} }, _savePoolForBroker: () => ({}), _tasksForBroker: () => ({}),
    onChange() {}, _maybeAutoName: async () => undefined };
  assert.equal((await submitWorkspaceSession(workspace, 'session-main', 'hello', 'gateway_update_21')).outcome, 'completed');
  assert.deepEqual(await submitWorkspaceSession(workspace, 'session-main', 'hello', 'gateway_update_21'), { duplicate: true });
  assert.deepEqual(projected, [{ type: 'user_input', text: 'hello' }]);
});

test('Telegram compact and confirmed clear control the standalone session without entering the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-context-'));
  const sent = [], modelSubmissions = [], controls = [];
  let polls = 0; let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      polls += 1;
      if (polls === 1) return [
        { update_id: 1, message: { text: '/compact', from: { id: 42 }, chat: { id: 42 } } },
        { update_id: 2, message: { text: '/handoff', from: { id: 42 }, chat: { id: 42 } } },
        { update_id: 3, message: { text: '/clear', from: { id: 42 }, chat: { id: 42 } } },
        { update_id: 4, callback_query: { id: 'clear-confirm', data: 'nna:clear:y', from: { id: 42 }, message: { chat: { id: 42 } } } },
      ];
      return pendingUntilAbort(signal);
    },
    async sendMessage(chatId, text, _signal, options) {
      sent.push({ chatId, text, options });
      if (text.startsWith('Conversation cleared.')) finished();
    },
    async answerCallbackQuery() {},
  };
  const gateway = new TelegramGateway({
    api, paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 8 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    sessionDirectory: { list: async () => [] },
    engineFactory: () => ({
      config: { executionManifest: null }, initialize: async () => undefined,
      submit: async (command) => { modelSubmissions.push(command.content); return { outcome: 'completed', text: 'model' }; },
      cancel: async () => ({ accepted: true }), shutdown: async () => ({ complete: true }),
      compactConversation: async () => { controls.push('compact'); return { omitted: 12, retained: 5, reduced: 2 }; },
      handoffConversation: async () => { controls.push('handoff'); return { omitted: 17, retained: 0 }; },
      clearConversation: async () => { controls.push('clear'); return { removed: 9, cleared: true }; },
    }),
  });
  const running = gateway.run(); await done; await gateway.shutdown(); await running;
  assert.deepEqual(controls, ['compact', 'handoff', 'clear']);
  assert.deepEqual(modelSubmissions, []);
  assert.match(sent.find((item) => item.text.startsWith('Context compacted.')).text, /Omitted 12/u);
  assert.match(sent.find((item) => item.text.startsWith('Terse self-handoff')).text, /17 records/u);
  assert.equal(sent.find((item) => item.text.startsWith('Clear all context')).options.replyMarkup.inline_keyboard[0][0].callback_data, 'nna:clear:y');
});

test('Telegram attach and detach controls are intercepted before the standalone model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-attach-'));
  const sent = [], callbacks = [], routed = [], created = [];
  let polls = 0; let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const target = { id: 'session-main', targetId: 'target123', alias: 'Main', summary: 'Building NNA', brokerId: 'broker', broker: {} };
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      polls += 1;
      if (polls === 1) return [
        { update_id: 1, message: { text: '/sessions', from: { id: 42 }, chat: { id: 42 } } },
        { update_id: 2, callback_query: { id: 'cb1', data: 'nna:a:target123', from: { id: 42 }, message: { chat: { id: 42 } } } },
        { update_id: 3, message: { text: 'continue here', from: { id: 42 }, chat: { id: 42 } } },
        { update_id: 4, message: { text: '/detach', from: { id: 42 }, chat: { id: 42 } } },
        { update_id: 5, message: { text: 'standalone', from: { id: 42 }, chat: { id: 42 } } },
      ];
      return pendingUntilAbort(signal);
    },
    async sendMessage(chatId, text, _signal, options) {
      sent.push({ chatId, text, options }); if (text.includes('standalone:standalone')) finished();
    },
    async answerCallbackQuery(id) { callbacks.push(id); },
  };
  const gateway = new TelegramGateway({
    api, paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 8 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    sessionDirectory: { list: async () => [target], submit: async (_target, text, requestId) => { routed.push([text, requestId]); return { outcome: 'completed', text: `attached:${text}` }; } },
    engineFactory: () => {
      created.push(true);
      return { config: { executionManifest: null }, initialize: async () => undefined,
        submit: async (command) => ({ outcome: 'completed', text: `standalone:${command.content}` }),
        cancel: async () => ({ accepted: true }), shutdown: async () => ({ complete: true }) };
    },
  });
  const running = gateway.run(); await done; await gateway.shutdown(); await running;
  assert.deepEqual(routed, [['continue here', 'gateway_update_3']]);
  assert.equal(created.length, 1);
  assert.deepEqual(callbacks, ['cb1']);
  assert.equal(sent.some((item) => item.text === 'attached:continue here' && item.options.replyMarkup), true);
});

test('attached Telegram sender receives admission and broker failure replies before acknowledgment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-attached-pending-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  const sent = [];
  let queuedAtFailureReply = false;
  let notified;
  const notice = new Promise((resolve) => { notified = resolve; });
  let polls = 0;
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      if (++polls === 1) return [
        { update_id: 1, message: { text: '/attach Main', from: { id: 42 }, chat: { id: 42 } } },
        { update_id: 2, message: { text: 'keep this message', from: { id: 42 }, chat: { id: 42 } } },
        { update_id: 3, message: { text: 'uncertain delivery', from: { id: 42 }, chat: { id: 42 } } },
      ];
      return pendingUntilAbort(signal);
    },
    async sendMessage(_chatId, text) {
      sent.push(text);
      if (text.includes('could not confirm delivery')) {
        queuedAtFailureReply = JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8'))
          .replies.some((item) => item.updateId === 3 && item.chatId === '42' && item.alias === 'Main');
        notified();
      }
    },
  };
  const target = { id: 'main', targetId: 'target-main', alias: 'Main', summary: 'Busy', brokerId: 'broker', broker: {} };
  const gateway = new TelegramGateway({
    api, paths, engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    sessionDirectory: { list: async () => [target], submit: async (_target, text) => {
      throw Object.assign(new Error('private broker failure'), {
        code: text === 'keep this message' ? 'turn_submission_pending' : 'broker_unavailable',
      });
    } },
  });
  const running = gateway.run();
  await notice;
  await waitUntil(async () => JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length === 0);
  await gateway.shutdown(); await running;
  assert.equal(sent.filter((text) => text.includes('Please send this one again')).length, 1);
  assert.equal(sent.filter((text) => text.includes('could not confirm delivery')).length, 1);
  assert.equal(queuedAtFailureReply, true);
  assert.equal(sent.some((text) => text.includes('private broker failure')), false);
});

test('attached failure reply survives Telegram send failure and restart without resubmission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-attached-reply-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  const target = { id: 'main', targetId: 'target-main', alias: 'Main', brokerId: 'broker', broker: {} };
  let submitted = 0, polls = 0;
  let deliveryFailed; const failedDelivery = new Promise((resolve) => { deliveryFailed = resolve; });
  const config = { authorized_user_ids: ['42'], polling_timeout_seconds: 5 };
  const engineConfig = { limits: { providerConcurrency: 1, providerQueueLimit: 4 } };
  const sessionDirectory = { list: async () => [target], submit: async () => {
    submitted += 1;
    throw Object.assign(new Error('private failure'), { code: 'broker_unavailable' });
  } };
  const update = (id, text) => ({ update_id: id, message: { text, from: { id: 42 }, chat: { id: 42 } } });
  const first = new TelegramGateway({
    paths, config, engineConfig, sessionDirectory,
    api: {
      async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        if (++polls === 1) return [update(1, '/attach Main'), update(2, 'keep target')];
        return pendingUntilAbort(signal);
      },
      async sendMessage(_chatId, text) {
        if (text.includes('could not confirm delivery')) {
          deliveryFailed();
          throw Object.assign(new Error('offline'), { code: 'telegram_unavailable' });
        }
      },
    },
  });
  const runningFirst = first.run();
  await failedDelivery;
  const persisted = JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8'));
  assert.equal(persisted.inbox.length, 0);
  assert.equal(persisted.replies.some((item) => item.updateId === 2), true);
  await first.shutdown(); await runningFirst;
  assert.equal(submitted, 1);

  const sent = [];
  const second = new TelegramGateway({
    paths, config, engineConfig, sessionDirectory,
    api: {
      async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    },
  });
  const runningSecond = second.run();
  await waitUntil(async () => sent.length === 1);
  await second.shutdown(); await runningSecond;
  assert.equal(submitted, 1);
  assert.equal(sent[0].chatId, '42');
  assert.match(sent[0].text, /could not confirm delivery/u);
  assert.equal(JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).replies.length, 0);
});

test('standalone answer survives Telegram send failure and restart without rerunning the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-standalone-reply-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  const config = { authorized_user_ids: ['42'], polling_timeout_seconds: 5 };
  const engineConfig = { limits: { providerConcurrency: 1, providerQueueLimit: 4 } };
  const update = { update_id: 3, message: { text: 'answer this', from: { id: 42 }, chat: { id: 42 } } };
  let turns = 0, polls = 0, failedDelivery;
  const deliveryFailed = new Promise((resolve) => { failedDelivery = resolve; });
  const first = new TelegramGateway({ paths, config, engineConfig,
    engineFactory: () => ({ config: { executionManifest: null }, initialize: async () => undefined,
      submit: async () => { turns += 1; return { outcome: 'completed', text: 'durable answer' }; },
      shutdown: async () => ({ complete: true }) }),
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        if (++polls === 1) return [update];
        return pendingUntilAbort(signal);
      },
      async sendMessage() { failedDelivery(); throw Object.assign(new Error('offline'), { code: 'telegram_unavailable' }); } },
  });
  const runningFirst = first.run();
  await deliveryFailed;
  await waitUntil(async () => JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length === 0);
  await first.shutdown(); await runningFirst;
  assert.equal(turns, 1);
  const persisted = JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8'));
  assert.equal(persisted.replies.length, 1);
  assert.equal(persisted.replies[0].text, 'durable answer');

  const sent = [];
  const second = new TelegramGateway({ paths, config, engineConfig,
    engineFactory: () => assert.fail('a completed standalone turn must not restart'),
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage(chatId, text, _signal, options) { sent.push({ chatId, text, options }); } },
  });
  const runningSecond = second.run();
  await waitUntil(async () => sent.length === 1);
  await second.shutdown(); await runningSecond;
  assert.deepEqual(sent, [{ chatId: '42', text: 'durable answer', options: {} }]);
  assert.equal(turns, 1);
  assert.equal(JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).replies.length, 0);
});

test('context command reply survives Telegram outage without repeating the committed effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-control-reply-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  const config = { authorized_user_ids: ['42'], polling_timeout_seconds: 5 };
  const engineConfig = { limits: { providerConcurrency: 1, providerQueueLimit: 4 } };
  const update = { update_id: 9, message: { text: '/compact', from: { id: 42 }, chat: { id: 42 } } };
  let compacted = 0, polls = 0, failedDelivery;
  const deliveryFailed = new Promise((resolve) => { failedDelivery = resolve; });
  const first = new TelegramGateway({ paths, config, engineConfig,
    engineFactory: () => ({ config: { executionManifest: null }, initialize: async () => undefined,
      compactConversation: async () => { compacted += 1; return { omitted: 4, retained: 2 }; },
      shutdown: async () => ({ complete: true }) }),
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        if (++polls === 1) return [update];
        return pendingUntilAbort(signal);
      },
      async sendMessage() { failedDelivery(); throw Object.assign(new Error('offline'), { code: 'telegram_unavailable' }); } },
  });
  const runningFirst = first.run();
  await deliveryFailed;
  await waitUntil(async () => JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length === 0);
  await first.shutdown(); await runningFirst;
  assert.equal(compacted, 1);
  const state = JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8'));
  assert.match(state.replies[0].text, /Context compacted/u);
  const sent = [];
  const second = new TelegramGateway({ paths, config, engineConfig,
    engineFactory: () => assert.fail('committed context control must not rerun'),
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage(_chatId, text) { sent.push(text); } },
  });
  const runningSecond = second.run();
  await waitUntil(async () => sent.length === 1);
  await second.shutdown(); await runningSecond;
  assert.match(sent[0], /Context compacted/u);
  assert.equal(compacted, 1);
});

test('cancel reply survives send failure without cancelling a later attached target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-cancel-reply-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  await mkdir(paths.gateway, { recursive: true });
  const update = { update_id: 5, message: { text: '/cancel', from: { id: 42 }, chat: { id: 42 } } };
  await writeFile(join(paths.gateway, 'state.json'), JSON.stringify({ version: 4, offset: 6,
    inbox: [update], attachments: { 42: { targetId: 'original', alias: 'Original' } },
    routes: {}, replies: [], operations: {} }));
  const config = { authorized_user_ids: ['42'], polling_timeout_seconds: 5 };
  const engineConfig = { limits: { providerConcurrency: 1, providerQueueLimit: 4 } };
  let cancelled = 0, failedDelivery;
  const deliveryFailed = new Promise((resolve) => { failedDelivery = resolve; });
  const target = { id: 'session-original', targetId: 'original', alias: 'Original', turn_id: 'turn-original', busy: true };
  const first = new TelegramGateway({ paths, config, engineConfig,
    sessionDirectory: { list: async () => [target], cancel: async (selected, expectedTurnId) => {
      assert.equal(selected.targetId, 'original'); assert.equal(expectedTurnId, 'turn-original');
      cancelled += 1; return { accepted: true }; } },
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage() { failedDelivery(); throw Object.assign(new Error('offline'), { code: 'telegram_unavailable' }); } },
  });
  const runningFirst = first.run();
  await deliveryFailed;
  await waitUntil(async () => JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length === 0);
  await first.shutdown(); await runningFirst;
  assert.equal(cancelled, 1);

  const sent = [];
  const second = new TelegramGateway({ paths, config, engineConfig,
    sessionDirectory: { list: async () => [{ id: 'later', targetId: 'later', alias: 'Later' }],
      cancel: async () => assert.fail('replay must not cancel the later target') },
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage(_chatId, text) { sent.push(text); } },
  });
  const runningSecond = second.run();
  await waitUntil(async () => sent.length === 1);
  await second.shutdown(); await runningSecond;
  assert.equal(cancelled, 1);
  assert.match(sent[0], /Cancellation requested for Original/u);
});

test('cancel fences an earlier queued chat submission across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-cancel-fence-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  const updates = [
    { update_id: 1, message: { text: 'do this work', from: { id: 42 }, chat: { id: 42 } } },
    { update_id: 2, message: { text: '/cancel', from: { id: 42 }, chat: { id: 42 } } },
  ];
  const sent = [];
  let polls = 0;
  const gateway = new TelegramGateway({ paths,
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    engineFactory: () => assert.fail('cancelled queued work must not create an engine'),
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        if (++polls === 1) return updates;
        return pendingUntilAbort(signal);
      }, async sendMessage(_chatId, text) { sent.push(text); } },
  });
  const running = gateway.run();
  await waitUntil(() => sent.length === 2);
  await gateway.shutdown(); await running;
  assert.ok(sent.some((text) => text === 'Message cancelled before starting.'));
  assert.ok(sent.some((text) => text === 'No active turn.'));

  await mkdir(paths.gateway, { recursive: true });
  await writeFile(join(paths.gateway, 'state.json'), JSON.stringify({ version: 4, offset: 3,
    inbox: [updates[0]], attachments: {}, routes: {}, replies: [], operations: {}, suppressed: { 1: 2 } }));
  const recovered = [];
  const second = new TelegramGateway({ paths, config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    engineFactory: () => assert.fail('durably suppressed work must not restart'),
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      }, async sendMessage(_chatId, text) { recovered.push(text); } },
  });
  const runningSecond = second.run();
  await waitUntil(() => recovered.length === 1);
  await second.shutdown(); await runningSecond;
  assert.deepEqual(recovered, ['Message cancelled before starting.']);
});

test('cancel suppresses an earlier submission waiting for session initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-cancel-inflight-'));
  let releaseInitialize, initialized;
  const initializeGate = new Promise((resolve) => { releaseInitialize = resolve; });
  const initializing = new Promise((resolve) => { initialized = resolve; });
  const sent = [];
  let polls = 0, submitted = 0;
  const gateway = new TelegramGateway({
    paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
      reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    engineFactory: () => ({ config: { executionManifest: null },
      async initialize() { initialized(); await initializeGate; },
      async submit() { submitted += 1; return { outcome: 'completed', text: 'unexpected' }; },
      async cancel() { return { accepted: true }; }, async shutdown() { return { complete: true }; } }),
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        if (++polls === 1) return [{ update_id: 1,
          message: { text: 'do work', from: { id: 42 }, chat: { id: 42 } } }];
        if (polls === 2) return [{ update_id: 2,
          message: { text: '/cancel', from: { id: 42 }, chat: { id: 42 } } }];
        return pendingUntilAbort(signal);
      }, async sendMessage(_chatId, text) { sent.push(text); } },
  });
  const running = gateway.run();
  try {
    await initializing;
    await waitUntil(() => sent.includes('No active turn.'));
    releaseInitialize();
    await waitUntil(() => sent.includes('Message cancelled before starting.'));
    assert.equal(submitted, 0);
  } finally {
    releaseInitialize();
    await gateway.shutdown(); await running;
  }
});

test('cancel compares the expected active turn at its effect boundary', async () => {
  let aborted = false;
  const result = await SessionEngine.prototype.cancel.call({
    active: { turnId: 'turn-B', controller: { abort() { aborted = true; } } },
  }, { type: 'cancel', request_id: 'cancel-A', expected_turn_id: 'turn-A' });
  assert.deepEqual(result, { accepted: true, already_terminal: true });
  assert.equal(aborted, false);
});

test('attached cancel does not abort a replacement turn after target discovery', async () => {
  const replies = [];
  let aborted = false;
  const engine = { active: { turnId: 'turn-A' } };
  await runGatewayContextAction({ action: 'cancel', chatId: '42', updateId: 7, userId: '42',
    selection: { targetId: 'original', alias: 'Original' },
    replay: { async beginControl() {}, async queueReply(_id, _chat, _user, message) { replies.push(message); } },
    directory: { async list() { return [{ targetId: 'original', alias: 'Original', turn_id: 'turn-A' }]; },
      async cancel(_target, expectedTurnId) {
        engine.active = { turnId: 'turn-B', controller: { abort() { aborted = true; } } };
        return SessionEngine.prototype.cancel.call(engine,
          { type: 'cancel', request_id: 'cancel-A', expected_turn_id: expectedTurnId });
      } },
    standalone: async () => assert.fail('attached cancel must not select standalone'),
    logger: { record() {} },
  });
  assert.equal(aborted, false);
  assert.deepEqual(replies, ['No active turn.']);
});

test('attached cancel with no observed target leaves a later turn untouched', async () => {
  const replies = [];
  await runGatewayContextAction({ action: 'cancel', chatId: '42', updateId: 8, userId: '42',
    selection: { targetId: 'original', alias: 'Original' },
    replay: { async beginControl() {}, async queueReply(_id, _chat, _user, message) { replies.push(message); } },
    directory: { async list() { return [{ targetId: 'original', alias: 'Original', turn_id: null }]; },
      async cancel() { assert.fail('an unobserved turn must not be cancelled'); } },
    standalone: async () => assert.fail('attached cancel must not select standalone'),
    logger: { record() {} },
  });
  assert.deepEqual(replies, ['No active turn.']);
});

test('uncertain cancellation never replays into a changed attachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-cancel-uncertain-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  await mkdir(paths.gateway, { recursive: true });
  await writeFile(join(paths.gateway, 'state.json'), JSON.stringify({ version: 4, offset: 10,
    inbox: [{ update_id: 9, message: { text: '/cancel', from: { id: 42 }, chat: { id: 42 } } }],
    attachments: { 42: { targetId: 'later', alias: 'Later' } }, routes: {}, replies: [],
    operations: { 9: { action: 'cancel', targetId: 'original' } } }));
  const sent = [];
  const gateway = new TelegramGateway({ paths, config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    sessionDirectory: { list: async () => assert.fail('uncertain cancel must not resolve later target'),
      cancel: async () => assert.fail('uncertain cancel must not replay') },
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage(_chatId, text) { sent.push(text); } },
  });
  const running = gateway.run();
  await waitUntil(async () => sent.length === 1);
  await gateway.shutdown(); await running;
  assert.match(sent[0], /could not confirm whether cancel took effect/u);
  assert.equal(JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).attachments['42'].targetId, 'later');
});

test('recovered uncertain clear never clears another conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-control-uncertain-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  await mkdir(paths.gateway, { recursive: true });
  const update = { update_id: 11, callback_query: { id: 'clear-confirm', data: 'nna:clear:y',
    from: { id: 42 }, message: { chat: { id: 42 } } } };
  await writeFile(join(paths.gateway, 'state.json'), JSON.stringify({ version: 4, offset: 12,
    inbox: [update], attachments: {}, routes: {}, replies: [],
    operations: { 11: { action: 'clear', targetId: 'previous-console' } } }));
  const sent = [];
  const gateway = new TelegramGateway({ paths, config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    engineFactory: () => assert.fail('uncertain clear must not create a standalone session'),
    sessionDirectory: { list: async () => assert.fail('uncertain clear must not re-resolve target'),
      clear: async () => assert.fail('uncertain clear must not replay') },
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage(_chatId, text) { sent.push(text); } },
  });
  const running = gateway.run();
  await waitUntil(async () => sent.length === 1);
  await gateway.shutdown(); await running;
  assert.match(sent[0], /could not confirm whether clear took effect/u);
  assert.equal(JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length, 0);
});

test('replayed ordinal attach cannot select a different Console target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-attach-ordinal-replay-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  await mkdir(paths.gateway, { recursive: true });
  await writeFile(join(paths.gateway, 'state.json'), JSON.stringify({ version: 4, offset: 7,
    inbox: [{ update_id: 6, message: { text: '/attach 1', from: { id: 42 }, chat: { id: 42 } } }],
    attachments: { 42: { targetId: 'original', alias: 'Original' } }, routes: {}, replies: [],
    operations: { 6: { action: 'attach', targetId: 'original' } } }));
  const sent = [];
  const gateway = new TelegramGateway({ paths, config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    sessionDirectory: { list: async () => assert.fail('ordinal must not be resolved again') },
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage(_chatId, text) { sent.push(text); } },
  });
  const running = gateway.run();
  await waitUntil(async () => sent.length === 1);
  await gateway.shutdown(); await running;
  assert.match(sent[0], /could not confirm whether attach took effect/u);
  const persisted = JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8'));
  assert.equal(persisted.attachments['42'].targetId, 'original');
});

test('malformed context result after an attempted effect yields an uncertain durable reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-control-malformed-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  const sent = []; let attempts = 0, polls = 0;
  const gateway = new TelegramGateway({ paths,
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    engineFactory: () => ({ config: { executionManifest: null }, initialize: async () => undefined,
      handoffConversation: async () => { attempts += 1; return null; },
      shutdown: async () => ({ complete: true }) }),
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        if (++polls === 1) return [{ update_id: 4, message: { text: '/handoff', from: { id: 42 }, chat: { id: 42 } } }];
        return pendingUntilAbort(signal);
      },
      async sendMessage(_chatId, text) { sent.push(text); } },
  });
  const running = gateway.run();
  await waitUntil(async () => sent.length === 1);
  await gateway.shutdown(); await running;
  assert.equal(attempts, 1);
  assert.match(sent[0], /could not confirm whether handoff took effect/u);
  assert.equal(JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length, 0);
});

test('busy handoff reports a known pre-effect rejection', async () => {
  const replies = [];
  await runGatewayContextAction({ action: 'handoff', chatId: '42', updateId: 3, userId: '42',
    replay: { async beginControl() {}, async queueReply(...args) { replies.push(args); } },
    selection: null, directory: {}, logger: { record() {} },
    standalone: async () => ({ async handoffConversation() {
      throw Object.assign(new Error('busy'), { code: 'handoff_busy' });
    } }),
  });
  assert.match(replies[0][3], /Cannot handoff while a turn is active/u);
});

test('callback acknowledgment error cannot erase a retained command attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-callback-retain-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  await mkdir(paths.gateway, { recursive: true });
  const update = { update_id: 8, callback_query: { id: 'detach', data: 'nna:d', from: { id: 42 },
    message: { chat: { id: 42 } }, padding: '' } };
  const state = { version: 4, offset: 9, inbox: [update], attachments: {}, routes: {}, replies: [], operations: {} };
  update.callback_query.padding = 'x'.repeat(1_048_550 - Buffer.byteLength(JSON.stringify(state)));
  await writeFile(join(paths.gateway, 'state.json'), JSON.stringify(state));
  const gateway = new TelegramGateway({ paths,
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    api: { async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async answerCallbackQuery() { throw new Error('callback API offline'); },
      async sendMessage() { assert.fail('state-full attempt must not send a reply'); } },
  });
  await gateway.run();
  const preserved = JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8'));
  assert.equal(preserved.inbox.length, 1);
  assert.equal(preserved.inbox[0].update_id, 8);
});

test('replayed attached update before route pin with vanished target never enters standalone session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-pinned-target-'));
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), telegramOutbox: join(root, 'outbox') };
  await mkdir(paths.gateway, { recursive: true });
  await writeFile(join(paths.gateway, 'state.json'), JSON.stringify({ version: 4, offset: 3,
    inbox: [{ update_id: 2, message: { text: 'keep target', from: { id: 42 }, chat: { id: 42 } } }],
    attachments: { 42: { targetId: 'old-target', alias: 'Main' } }, routes: {}, replies: [], operations: {} }));
  const sent = [];
  const gateway = new TelegramGateway({
    paths, config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    sessionDirectory: { list: async () => [], submit: async () => assert.fail('must not submit') },
    engineFactory: () => assert.fail('must not create standalone session'),
    api: {
      async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        return pendingUntilAbort(signal);
      },
      async sendMessage(_chatId, text) { sent.push(text); },
    },
  });
  const running = gateway.run();
  await waitUntil(async () => sent.length === 1);
  await gateway.shutdown(); await running;
  assert.match(sent[0], /no longer available/u);
  assert.match(sent[0], /not sent elsewhere/u);
});

async function terminalJournal(root, sessionId, turnId, outcome = 'completed') {
  const store = new JournalStore(root, sessionId);
  await store.open();
  await store.append('turn_outcome', { turn_id: turnId, outcome });
  await store.close();
}

test('Telegram notification queue publishes only at terminal turn state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-outbox-'));
  const sessions = join(root, 'sessions');
  const outbox = join(root, 'outbox');
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  await queue.schedule('turn-1', 'The audit is complete.');
  assert.deepEqual(await readTelegramOutbox(outbox, sessions), []);
  await terminalJournal(sessions, 'session-main', 'turn-1');
  await queue.terminal({ type: 'turn_result', turn_id: 'turn-1', outcome: 'completed' });
  const [item] = await readTelegramOutbox(outbox, sessions);
  assert.equal(item.message, 'The audit is complete.');
  assert.equal(item.session_id, 'session-main');
  assert.equal(item.outcome, 'completed');
});

test('Telegram notification intent survives restart and only reconciles after a verified outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-reconcile-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  await queue.schedule('turn-1', 'The audit is complete.');
  assert.equal(await reconcileTelegramNotifications(outbox, sessions), 0);
  assert.deepEqual(await readTelegramOutbox(outbox, sessions), []);
  await terminalJournal(sessions, 'session-main', 'turn-1', 'failed');
  assert.equal(await reconcileTelegramNotifications(outbox, sessions), 1);
  assert.equal(await reconcileTelegramNotifications(outbox, sessions), 0);
  const [item] = await readTelegramOutbox(outbox, sessions);
  assert.equal(item.outcome, 'failed');
  assert.equal(item.message, 'The audit is complete.');
});

test('malformed Telegram intent cannot block valid terminal notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-malformed-intent-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  await queue.schedule('turn-1', 'Finished safely.');
  await terminalJournal(sessions, 'session-main', 'turn-1');
  const invalid = join(outbox, 'pending', `${'0'.repeat(64)}.json`);
  await writeFile(invalid, '{broken');
  let invalidCount = 0;
  assert.equal(await reconcileTelegramNotifications(outbox, sessions, { onInvalid: () => { invalidCount += 1; } }), 1);
  assert.equal(invalidCount, 1);
  assert.equal((await readTelegramOutbox(outbox, sessions))[0].message, 'Finished safely.');
  assert.equal(await readFile(invalid, 'utf8'), '{broken');
});

test('ready Telegram notifications rotate past a batch of unavailable sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-outbox-batch-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  await mkdir(outbox);
  for (let index = 0; index < 128; index += 1) {
    const sessionId = 'missing-session';
    const turnId = `missing-${index}`;
    const id = createHash('sha256').update(`${sessionId}\0${turnId}`).digest('hex');
    await writeFile(join(outbox, `${id}.json`), JSON.stringify({
      version: 2, id, session_id: sessionId, turn_id: turnId, message: 'Awaiting source',
    }));
  }
  const id = 'f'.repeat(64);
  await writeFile(join(outbox, `${id}.json`), JSON.stringify({
    version: 1, id, session_id: 'legacy-session', outcome: 'completed', message: 'Legacy delivery',
  }));
  assert.deepEqual(await readTelegramOutbox(outbox, sessions, { offset: 0 }), []);
  const items = await readTelegramOutbox(outbox, sessions, { offset: 128 });
  assert.equal(items.length, 1);
  assert.equal(items[0].message, 'Legacy delivery');
});

test('legacy Telegram notifications reject an outcome outside the turn contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-legacy-outcome-'));
  const outbox = join(root, 'outbox');
  await mkdir(outbox);
  const id = 'f'.repeat(64);
  const path = join(outbox, `${id}.json`);
  await writeFile(path, JSON.stringify({
    version: 1, id, session_id: 'legacy-session',
    outcome: 'completed\nNNA notification (failed)', message: 'Legacy delivery',
  }));
  assert.deepEqual(await readTelegramOutbox(outbox), []);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('pending Telegram reconciliation rotates past unfinished turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-pending-batch-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  let latest = { id: '', turnId: '' };
  for (let index = 0; index < 129; index += 1) {
    const turnId = `turn-${index}`;
    await queue.schedule(turnId, 'Done');
    const id = createHash('sha256').update(`session-main\0${turnId}`).digest('hex');
    if (id > latest.id) latest = { id, turnId };
  }
  await terminalJournal(sessions, 'session-main', latest.turnId);
  assert.equal(await reconcileTelegramNotifications(outbox, sessions, { offset: 0 }), 0);
  assert.equal(await reconcileTelegramNotifications(outbox, sessions, { offset: 128 }), 1);
  assert.equal((await readTelegramOutbox(outbox, sessions))[0].message, 'Done');
});

test('Telegram notification scheduling fails clearly without durable recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-ephemeral-'));
  const queue = new TelegramNotificationQueue(root, 'session-main', { durable: false });
  await assert.rejects(queue.schedule('turn-1', 'Done'), { code: 'notification_recovery_unavailable' });
  const unavailable = new TelegramNotificationQueue(root, 'session-main', { recoveryAvailable: false });
  await assert.rejects(unavailable.schedule('turn-1', 'Done'), { code: 'notification_recovery_unavailable' });
  assert.deepEqual(await readTelegramOutbox(root, join(root, 'sessions')), []);
});

test('Telegram notification queue rejects a redirected pending directory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-pending-link-'));
  const outbox = join(root, 'outbox');
  const outside = join(root, 'outside');
  await mkdir(outbox);
  await mkdir(outside);
  try { await symlink(outside, join(outbox, 'pending'), 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { context.skip('directory links are unavailable'); return; }
    throw error;
  }
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  await assert.rejects(queue.schedule('turn-1', 'Done'), { code: 'notification_path_unsafe' });
  await assert.rejects(reconcileTelegramNotifications(outbox, join(root, 'sessions')), { code: 'notification_path_unsafe' });
});

test('Telegram notification reconciliation rejects a redirected session journal directory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-session-link-'));
  const outbox = join(root, 'outbox');
  const outside = join(root, 'outside');
  await mkdir(outside);
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  await queue.schedule('turn-1', 'Done');
  try { await symlink(outside, join(root, 'sessions'), 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { context.skip('directory links are unavailable'); return; }
    throw error;
  }
  await assert.rejects(reconcileTelegramNotifications(outbox, join(root, 'sessions')), { code: 'notification_path_unsafe' });
});

async function corruptTerminalJournal(root, sessionId) {
  const path = join(root, `${sessionId}.journal.ndjson`);
  const lines = (await readFile(path, 'utf8')).split('\n');
  const record = JSON.parse(lines[0]);
  record.payload.outcome = 'corrupted';
  lines[0] = JSON.stringify(record);
  await writeFile(path, lines.join('\n'));
}

test('a corrupt notification source does not block another pending session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-pending-source-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const bad = new TelegramNotificationQueue(outbox, 'bad-session');
  const good = new TelegramNotificationQueue(outbox, 'good-session');
  await bad.schedule('bad-turn', 'Bad source');
  await good.schedule('good-turn', 'Good source');
  await terminalJournal(sessions, 'bad-session', 'bad-turn');
  await terminalJournal(sessions, 'good-session', 'good-turn');
  await corruptTerminalJournal(sessions, 'bad-session');
  const failures = [];
  assert.equal(await reconcileTelegramNotifications(outbox, sessions, {
    onSourceError: (sessionId, code) => failures.push({ sessionId, code }),
  }), 1);
  assert.deepEqual(failures, [{ sessionId: 'bad-session', code: 'notification_journal_invalid' }]);
  assert.equal((await readTelegramOutbox(outbox, sessions))[0].message, 'Good source');
  const badId = createHash('sha256').update('bad-session\0bad-turn').digest('hex');
  assert.equal(JSON.parse(await readFile(join(outbox, 'pending', `${badId}.json`), 'utf8')).message, 'Bad source');
});

test('a corrupt ready notification source does not block another ready session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-ready-source-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const bad = new TelegramNotificationQueue(outbox, 'bad-session');
  const good = new TelegramNotificationQueue(outbox, 'good-session');
  await bad.schedule('bad-turn', 'Bad source');
  await good.schedule('good-turn', 'Good source');
  await terminalJournal(sessions, 'bad-session', 'bad-turn');
  await terminalJournal(sessions, 'good-session', 'good-turn');
  await bad.terminal({ turn_id: 'bad-turn', outcome: 'completed' });
  await good.terminal({ turn_id: 'good-turn', outcome: 'completed' });
  await corruptTerminalJournal(sessions, 'bad-session');
  const failures = [];
  const items = await readTelegramOutbox(outbox, sessions, {
    onSourceError: (sessionId, code) => failures.push({ sessionId, code }),
  });
  assert.deepEqual(items.map((item) => item.message), ['Good source']);
  assert.deepEqual(failures, [{ sessionId: 'bad-session', code: 'notification_journal_invalid' }]);
  const badId = createHash('sha256').update('bad-session\0bad-turn').digest('hex');
  assert.equal(JSON.parse(await readFile(join(outbox, `${badId}.json`), 'utf8')).message, 'Bad source');
});

test('a failed ready file read does not block another ready notification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-ready-file-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const good = new TelegramNotificationQueue(outbox, 'good-session');
  await good.schedule('good-turn', 'Good source');
  await terminalJournal(sessions, 'good-session', 'good-turn');
  await good.terminal({ turn_id: 'good-turn', outcome: 'completed' });
  await mkdir(join(outbox, `${'0'.repeat(64)}.json`));
  const failures = [];
  const items = await readTelegramOutbox(outbox, sessions, {
    onFileError: (name, code) => failures.push({ name, code }),
  });
  assert.deepEqual(items.map((item) => item.message), ['Good source']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, `${'0'.repeat(64)}.json`);
  assert.ok(['EISDIR', 'EPERM', 'EACCES'].includes(failures[0].code));
});

test('notification journal cancellation is not converted into a skipped source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-source-cancel-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  await queue.schedule('turn-1', 'Done');
  await terminalJournal(sessions, 'session-main', 'turn-1');
  const controller = new AbortController();
  controller.abort();
  let skipped = false;
  await assert.rejects(reconcileTelegramNotifications(outbox, sessions, {
    signal: controller.signal, onSourceError: () => { skipped = true; },
  }), (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  assert.equal(skipped, false);
});

test('gateway delivers terminal notifications out of band with an attach control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-delivery-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  await queue.schedule('turn-1', 'Finished the requested audit.');
  await terminalJournal(sessions, 'session-main', 'turn-1');
  await queue.terminal({ type: 'turn_result', turn_id: 'turn-1', outcome: 'completed' });
  let sentResolve; const delivered = new Promise((resolve) => { sentResolve = resolve; });
  const sent = [];
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      if (sent.length === 0) return [];
      return pendingUntilAbort(signal);
    },
    async sendMessage(chatId, text, _signal, options) { sent.push({ chatId, text, options }); sentResolve(); },
  };
  const target = { id: 'session-main', targetId: 'target123', alias: 'Main', summary: 'Audit', brokerId: 'broker', broker: {} };
  const gateway = new TelegramGateway({
    api, paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions, reviewerLedger: join(root, 'reviewer'), telegramOutbox: outbox },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    sessionDirectory: { list: async () => [target] },
  });
  const running = gateway.run(); await delivered; await gateway.shutdown(); await running;
  assert.equal(sent[0].chatId, '42');
  assert.match(sent[0].text, /Finished the requested audit/u);
  assert.equal(sent[0].options.replyMarkup.inline_keyboard[0][0].callback_data, 'nna:a:target123');
  assert.deepEqual(await readTelegramOutbox(outbox), []);
});

test('gateway acknowledges notifications after their source session closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-closed-source-'));
  const outbox = join(root, 'outbox');
  const sessions = join(root, 'sessions');
  const queue = new TelegramNotificationQueue(outbox, 'closed-session');
  await queue.schedule('turn-1', 'The completed turn is ready.');
  await terminalJournal(sessions, 'closed-session', 'turn-1');
  await queue.terminal({ type: 'turn_result', turn_id: 'turn-1', outcome: 'completed' });
  const sent = [];
  const gateway = new TelegramGateway({
    api: {
      async getMe() { return { id: 1 }; },
      async getUpdates(_offset, _timeout, signal) {
        if (sent.length === 0) return [];
        return pendingUntilAbort(signal);
      },
      async sendMessage(chatId, text, _signal, options) { sent.push({ chatId, text, options }); },
    },
    paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions,
      reviewerLedger: join(root, 'reviewer'), telegramOutbox: outbox },
    engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 4 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    sessionDirectory: { list: async () => [] },
  });
  const running = gateway.run();
  try {
    await waitUntil(() => sent.length === 1);
    await waitUntil(async () => (await readTelegramOutbox(outbox, sessions)).length === 0);
  } finally {
    await gateway.shutdown();
    await running;
  }
  assert.equal(sent[0].chatId, '42');
  assert.match(sent[0].text, /completed turn is ready/u);
  assert.deepEqual(sent[0].options, {});
});

function notificationDeliveryGateway(root, sendMessage, ids = ['41', '42', '43']) {
  return {
    paths: { telegramOutbox: join(root, 'outbox'), sessions: join(root, 'sessions') },
    config: { enabled: true, authorized_user_ids: ids },
    controller: new AbortController(), notificationCursor: 0, notificationIntentCursor: 0,
    invalidNotificationIntents: new Set(), attachments: new Map(),
    sessionDirectory: { list: async () => [] },
    logger: { record() {} }, api: { sendMessage },
  };
}

async function readyDeliveryNotification(root, turnId, message) {
  const queue = new TelegramNotificationQueue(join(root, 'outbox'), 'session-main');
  await queue.schedule(turnId, message);
  await terminalJournal(join(root, 'sessions'), 'session-main', turnId);
  await queue.terminal({ type: 'turn_result', turn_id: turnId, outcome: 'completed' });
}

test('a failed Telegram recipient does not block later recipients or notifications; restart skips successes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-recipient-progress-'));
  await readyDeliveryNotification(root, 'turn-1', 'first');
  await readyDeliveryNotification(root, 'turn-2', 'second');
  const sent = []; let fail42 = true;
  const send = async (chatId, message) => {
    sent.push(`${chatId}:${message.endsWith('first') ? 'first' : 'second'}`);
    if (chatId === '42' && message.endsWith('first') && fail42) throw Object.assign(new Error('unavailable'), { code: 'telegram_unavailable' });
  };
  const gateway = notificationDeliveryGateway(root, send);
  await drainGatewayNotifications(gateway);
  assert(sent.includes('43:first'));
  assert(sent.includes('41:second'));
  assert.equal((await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions'))).length, 1);
  fail42 = false;
  await drainGatewayNotifications(notificationDeliveryGateway(root, send));
  assert.equal(sent.filter((item) => item === '41:first').length, 1);
  assert.equal(sent.filter((item) => item === '43:first').length, 1);
  assert.equal(sent.filter((item) => item === '42:first').length, 2);
  assert.deepEqual(await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions')), []);
});

test('Telegram delivery snapshot excludes new grants and skips revoked recipients after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-recipient-revoke-'));
  await readyDeliveryNotification(root, 'turn-1', 'finished');
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ enabled: true, authorized_user_ids: ['41', '42'] }));
  const sent = [];
  const first = notificationDeliveryGateway(root, async (id) => {
    sent.push(id);
    if (id === '42') throw Object.assign(new Error('unavailable'), { code: 'telegram_unavailable' });
  });
  first.paths.gatewayConfig = configPath;
  await drainGatewayNotifications(first);
  assert.deepEqual(sent, ['41', '42']);
  await writeFile(configPath, JSON.stringify({ enabled: true, authorized_user_ids: ['41', '43'] }));
  const restarted = notificationDeliveryGateway(root, async (id) => { sent.push(id); });
  restarted.paths.gatewayConfig = configPath;
  await drainGatewayNotifications(restarted);
  assert.deepEqual(sent, ['41', '42']);
  assert.deepEqual(await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions')), []);
});

test('failed recipient checkpoint preserves ready notification and limits replay to uncheckpointed recipient', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-recipient-checkpoint-'));
  await readyDeliveryNotification(root, 'turn-1', 'finished');
  const sent = [];
  const send = async (id) => { sent.push(id); };
  const gateway = notificationDeliveryGateway(root, send);
  await drainGatewayNotifications(gateway, { persistState: async () => {
    throw Object.assign(new Error('disk failure'), { code: 'EIO' });
  } });
  assert.deepEqual(sent, ['41']);
  assert.equal((await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions'))).length, 1);
  await drainGatewayNotifications(notificationDeliveryGateway(root, send));
  assert.deepEqual(sent, ['41', '41', '42', '43']);
  assert.deepEqual(await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions')), []);
});

test('revoking every snapshotted Telegram recipient completes without sending to a new grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-revoke-all-'));
  await readyDeliveryNotification(root, 'turn-1', 'finished');
  const sent = [];
  await drainGatewayNotifications(notificationDeliveryGateway(root, async (id) => {
    sent.push(id);
    throw Object.assign(new Error('unavailable'), { code: 'telegram_unavailable' });
  }, ['41', '42']));
  const restarted = notificationDeliveryGateway(root, async (id) => { sent.push(id); }, ['43']);
  await drainGatewayNotifications(restarted);
  assert.deepEqual(sent, ['41', '42']);
  assert.deepEqual(await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions')), []);
});

test('Telegram notification with an empty authorized audience settles without sending or retaining backlog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-empty-audience-'));
  await readyDeliveryNotification(root, 'turn-1', 'finished');
  const events = [];
  const gateway = notificationDeliveryGateway(root, async () => {
    assert.fail('an empty authorized audience must not receive a notification');
  }, []);
  gateway.logger.record = (event) => { events.push(event); };
  await drainGatewayNotifications(gateway);
  assert.deepEqual(await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions')), []);
  assert(events.some((event) => event.type === 'gateway_notification_skipped' && event.revoked_count === 0));
});

test('malformed Telegram recipient progress preserves evidence and does not block another item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-recipient-malformed-'));
  await readyDeliveryNotification(root, 'turn-1', 'first');
  await readyDeliveryNotification(root, 'turn-2', 'second');
  const firstId = createHash('sha256').update('session-main\0turn-1').digest('hex');
  const statePath = join(root, 'outbox', 'delivery', `${firstId}.json`);
  await mkdir(join(root, 'outbox', 'delivery'));
  await writeFile(statePath, '{');
  const sent = [];
  const gateway = notificationDeliveryGateway(root, async (_id, message) => { sent.push(message); }, ['41']);
  await drainGatewayNotifications(gateway);
  assert.equal(await readFile(statePath, 'utf8'), '{');
  assert.deepEqual(sent.map((message) => message.endsWith('second')), [true]);
  assert.equal((await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions'))).length, 1);
});

test('Telegram recipient progress rejects a non-object audience instead of acknowledging it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-recipient-shape-'));
  await readyDeliveryNotification(root, 'turn-1', 'finished');
  const id = createHash('sha256').update('session-main\0turn-1').digest('hex');
  const statePath = join(root, 'outbox', 'delivery', `${id}.json`);
  await mkdir(join(root, 'outbox', 'delivery'));
  const sent = [];
  const gateway = notificationDeliveryGateway(root, async (chatId) => { sent.push(chatId); }, ['41']);
  for (const recipients of [null, []]) {
    await writeFile(statePath, JSON.stringify({ version: 1, notification_id: id, next_recipient: 0, recipients }));
    await drainGatewayNotifications(gateway);
    assert.deepEqual(sent, []);
    assert.equal((await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions'))).length, 1);
  }
});

test('Telegram recipient retry cursor reaches later recipients after four earlier failures and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-recipient-fairness-'));
  await readyDeliveryNotification(root, 'turn-1', 'finished');
  const ids = ['41', '42', '43', '44', '45', '46'];
  const sent = [];
  const send = async (chatId) => {
    sent.push(chatId);
    if (ids.slice(0, 4).includes(chatId)) throw Object.assign(new Error('unavailable'), { code: 'telegram_unavailable' });
  };
  await drainGatewayNotifications(notificationDeliveryGateway(root, send, ids));
  assert.deepEqual(sent, ids.slice(0, 4));
  await drainGatewayNotifications(notificationDeliveryGateway(root, send, ids));
  assert.deepEqual(sent, [...ids.slice(0, 4), '45', '46', '41', '42']);
  assert.equal(sent.filter((id) => id === '45').length, 1);
  assert.equal(sent.filter((id) => id === '46').length, 1);
  assert.equal((await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions'))).length, 1);
});

test('Telegram delivery sidecar cleanup rotates through bounded orphan batches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-recipient-orphans-'));
  const directory = join(root, 'outbox', 'delivery');
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < 40; index += 1) {
    await writeFile(join(directory, `${index.toString(16).padStart(64, '0')}.json`), '{}');
  }
  const gateway = notificationDeliveryGateway(root, async () => undefined);
  await drainGatewayNotifications(gateway);
  assert.equal((await readdir(directory)).length, 8);
  await drainGatewayNotifications(gateway);
  assert.deepEqual(await readdir(directory), []);
});

test('bounded Telegram recipient delivery rotates through more ready items than one drain can send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-delivery-rotation-'));
  const queue = new TelegramNotificationQueue(join(root, 'outbox'), 'session-main');
  const store = new JournalStore(join(root, 'sessions'), 'session-main');
  await store.open();
  for (let index = 0; index < 40; index += 1) {
    const turnId = `turn-${index}`;
    await queue.schedule(turnId, `message-${index}`);
    await store.append('turn_outcome', { turn_id: turnId, outcome: 'completed' });
    await queue.terminal({ type: 'turn_result', turn_id: turnId, outcome: 'completed' });
  }
  await store.close();
  const sent = [];
  const gateway = notificationDeliveryGateway(root, async (_id, message) => { sent.push(message); }, ['41']);
  await drainGatewayNotifications(gateway);
  assert.equal(sent.length, 32);
  await drainGatewayNotifications(gateway);
  assert.equal(sent.length, 40);
  assert.deepEqual(await readTelegramOutbox(join(root, 'outbox'), join(root, 'sessions')), []);
});
