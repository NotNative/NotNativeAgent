// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatewayPublicStatus, gatewayToken, loadGatewayConfig, normalizeGatewayConfig, saveGatewayConfig,
} from '../src/gateway-config.js';
import { splitTelegramText, TelegramApi } from '../src/telegram-api.js';
import { gatewaySessionId, TelegramGateway } from '../src/telegram-gateway.js';
import { commandDefinition } from '../src/tui-commands.js';
import { configOverlay, gatewayOverlay, overlayCommandDraft } from '../src/tui-overlays.js';

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
