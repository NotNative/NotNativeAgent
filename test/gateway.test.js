// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatewayPublicStatus, gatewayToken, loadGatewayConfig, normalizeGatewayConfig, saveGatewayConfig,
} from '../src/gateway/config.js';
import { splitTelegramText, TelegramApi } from '../src/gateway/telegram-api.js';
import { gatewaySessionId, TelegramGateway } from '../src/gateway/telegram.js';
import { ConsoleSessionBroker, ConsoleSessionDirectory } from '../src/session-broker.js';
import { readTelegramOutbox, TelegramNotificationQueue } from '../src/notifications/telegram.js';
import { commandDefinition } from '../src/tui/commands.js';
import { configOverlay, gatewayOverlay, overlayCommandDraft } from '../src/tui/overlays.js';
import { gatewayShutdownDiagnostic, runGatewayCommand, runtimeStatus } from '../src/gateway-cli.js';

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* State may not be published yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not settle before deadline');
}

test('gateway shutdown diagnostics expose only a stable code', () => {
  const diagnostic = gatewayShutdownDiagnostic({ code: 'close failed', message: 'private token detail' });
  assert.equal(diagnostic, 'nna gateway: close_failed\n');
  assert.doesNotMatch(diagnostic, /private|token/u);
});

test('gateway config is absent-safe, bounded, durable, and redacted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-'));
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
    return new Response(JSON.stringify({ ok: true, result: { id: 5, username: 'nna_test' } }), { status: 200 });
  } });
  assert.equal((await api.getMe()).username, 'nna_test');
  await api.sendMessage('99', 'a'.repeat(8_300));
  assert.equal(calls.length, 4);
  assert.equal(calls.every((item) => item.init.method === 'POST'), true);
  await api.getUpdates(0, 5);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body).allowed_updates, ['message', 'callback_query']);
  assert.equal(splitTelegramText('a'.repeat(8_300)).length, 3);
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

test('gateway start failure is reported without publishing a false pid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-start-failure-'));
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
  const root = await mkdtemp(join(tmpdir(), 'nna-gateway-foreground-'));
  const paths = {
    root, config: join(root, 'config'), gateway: join(root, 'runtime', 'gateway'),
    logs: join(root, 'logs'), gatewayConfig: join(root, 'config', 'gateway.json'),
    trustedWorkspaces: join(root, 'config', 'trusted-workspaces.json'),
    hooks: join(root, 'hooks'), skills: join(root, 'skills'),
    sessionBrokers: join(root, 'runtime', 'session-brokers'),
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
  const captured = []; const methods = [];
  const processIdentity = {
    async capture(pid) {
      captured.push(pid);
      return { version: 1, pid, platform: 'fixture', start_id: 'foreground' };
    },
  };
  const fetch = async (url) => {
    const method = new URL(url).pathname.split('/').at(-1);
    methods.push(method);
    const result = method === 'getMe' ? { id: 1, username: 'fixture' } : null;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };

  await assert.rejects(runGatewayCommand(['run'], paths, {
    environment: {}, input: null, processIdentity, fetch,
  }), { name: 'TypeError', message: 'updates is not iterable' });
  assert.deepEqual(captured, [process.pid]);
  assert.deepEqual(methods, ['getMe', 'getUpdates']);
  await assert.rejects(readFile(join(paths.gateway, 'gateway.pid')), { code: 'ENOENT' });
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
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async sendMessage() {},
  };
  const submitted = [];
  const paths = { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer') };
  const gateway = new TelegramGateway({
    api, paths, engineConfig: { limits: { providerConcurrency: 1, providerQueueLimit: 32 } },
    config: { authorized_user_ids: ['42'], polling_timeout_seconds: 5 },
    engineFactory: () => ({
      config: { executionManifest: null }, initialize: async () => undefined,
      submit: async (command) => { submitted.push(command.request_id); await gate; return { outcome: 'completed', text: 'ok' }; },
      cancel: async () => ({ accepted: true }), shutdown: async () => ({ complete: true }),
    }),
  });
  const running = gateway.run();
  await waitUntil(async () => JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length === 17);
  release();
  await waitUntil(() => submitted.length === 17);
  await waitUntil(async () => JSON.parse(await readFile(join(paths.gateway, 'state.json'), 'utf8')).inbox.length === 0);
  await gateway.shutdown(); await running;
  assert.equal(new Set(submitted).size, 17);
  assert.deepEqual(submitted.sort(), updates.map((item) => `gateway_update_${item.update_id}`).sort());
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
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
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
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
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
    submitSession: async (id, content) => { calls.push(['submit', id, content]); return { outcome: 'completed', text: 'done' }; },
    cancelSession: async (id) => { calls.push(['cancel', id]); return { accepted: true }; },
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
    assert.deepEqual(await directory.cancel(target), { accepted: true });
    assert.deepEqual(await directory.compact(target), { omitted: 8, retained: 3, reduced: 1 });
    assert.deepEqual(await directory.handoff(target), { omitted: 11, retained: 0 });
    assert.deepEqual(await directory.clear(target), { removed: 4, cleared: true });
    assert.deepEqual(calls, [
      ['submit', 'session-main', 'continue here'], ['cancel', 'session-main'],
      ['compact', 'session-main'], ['handoff', 'session-main'], ['clear', 'session-main'],
    ]);
  } finally { await broker.close(); }
  assert.deepEqual(await directory.list(), []);
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
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
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
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
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
    sessionDirectory: { list: async () => [target], submit: async (_target, text) => { routed.push(text); return { outcome: 'completed', text: `attached:${text}` }; } },
    engineFactory: () => {
      created.push(true);
      return { config: { executionManifest: null }, initialize: async () => undefined,
        submit: async (command) => ({ outcome: 'completed', text: `standalone:${command.content}` }),
        cancel: async () => ({ accepted: true }), shutdown: async () => ({ complete: true }) };
    },
  });
  const running = gateway.run(); await done; await gateway.shutdown(); await running;
  assert.deepEqual(routed, ['continue here']);
  assert.equal(created.length, 1);
  assert.deepEqual(callbacks, ['cb1']);
  assert.equal(sent.some((item) => item.text === 'attached:continue here' && item.options.replyMarkup), true);
});

test('Telegram notification queue publishes only at terminal turn state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-outbox-'));
  const queue = new TelegramNotificationQueue(root, 'session-main');
  queue.schedule('turn-1', 'The audit is complete.');
  assert.deepEqual(await readTelegramOutbox(root), []);
  await queue.terminal({ type: 'turn_result', turn_id: 'turn-1', outcome: 'completed' });
  const [item] = await readTelegramOutbox(root);
  assert.equal(item.message, 'The audit is complete.');
  assert.equal(item.session_id, 'session-main');
  assert.equal(item.outcome, 'completed');
});

test('gateway delivers terminal notifications out of band with an attach control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-telegram-delivery-'));
  const outbox = join(root, 'outbox');
  const queue = new TelegramNotificationQueue(outbox, 'session-main');
  queue.schedule('turn-1', 'Finished the requested audit.');
  await queue.terminal({ type: 'turn_result', turn_id: 'turn-1', outcome: 'completed' });
  let sentResolve; const delivered = new Promise((resolve) => { sentResolve = resolve; });
  const sent = [];
  const api = {
    async getMe() { return { id: 1 }; },
    async getUpdates(_offset, _timeout, signal) {
      if (sent.length === 0) return [];
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async sendMessage(chatId, text, _signal, options) { sent.push({ chatId, text, options }); sentResolve(); },
  };
  const target = { id: 'session-main', targetId: 'target123', alias: 'Main', summary: 'Audit', brokerId: 'broker', broker: {} };
  const gateway = new TelegramGateway({
    api, paths: { gateway: join(root, 'gateway'), logs: join(root, 'logs'), sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), telegramOutbox: outbox },
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
