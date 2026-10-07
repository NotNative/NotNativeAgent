// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNndGatewayStatusService, createNndGatewayTestService,
  createNndSearxngStatusService, projectGatewayStatus, projectGatewayTest,
  projectSearxngStatus, gatewayActionRefusal, searxngActionRefusal,
  dispatchNndActionTriageRequest } from '../src/nnd-action-triage-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { ContractError } from '../src/ids.js';

const token = 'action-triage-token-32-characters-long-testok';
const PERMITTED = { subjectId: 'operator@example.com',
  permissions: ['nnd.configuration.read', 'nnd.service.manage'] };
const base = 'http://127.0.0.1';

test('gateway status/test services use the CLI authorities verbatim and refuse runtime verbs honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nnd-triage-'));
  try {
    const paths = { gatewayConfig: join(root, 'gateway.json'), gateway: join(root, 'runtime', 'gateway') };
    await mkdir(paths.gateway, { recursive: true });
    await writeFile(paths.gatewayConfig, JSON.stringify({ format_version: 1, enabled: true,
      token: null, token_env: 'NNA_TELEGRAM_BOT_TOKEN', workspace_root: 'C:\\ws',
      polling_timeout_seconds: 30, authorized_user_ids: ['124'],
      updated_at: '2026-10-07T00:00:00.000Z' }));
    const environment = { NNA_TELEGRAM_BOT_TOKEN: '123:telegram-test-token' };
    const statusService = createNndGatewayStatusService({ paths, installationId: 'install_triage',
      dataId: 'data_triage', environment,
      statusRunner: async () => ({ running: true, verified: true, pid: 4242 }) });
    const receipt = projectGatewayStatus(await statusService.status());
    assert.equal(receipt.config.enabled, true);
    assert.equal(receipt.config.token_source, 'NNA_TELEGRAM_BOT_TOKEN');
    assert.deepEqual(receipt.config.authorized_user_ids, ['124']);
    assert.deepEqual(receipt.runtime, { running: true, verified: true, pid: 4242 });
    const testService = createNndGatewayTestService({ paths, installationId: 'install_triage',
      dataId: 'data_triage', environment,
      telegramFactory: () => ({ getMe: async () => ({ id: 7, username: 'demo_bot' }) }) });
    const tested = projectGatewayTest(await testService.test());
    assert.equal(tested.ok, true);
    assert.deepEqual(tested.bot, { id: 7, username: 'demo_bot' });
    const missing = projectGatewayTest(await createNndGatewayTestService({ paths,
      installationId: 'install_triage', dataId: 'data_triage', environment: {},
      telegramFactory: () => ({ getMe: async () => ({ id: 1 }) }) }).test());
    assert.equal(missing.refused, true);
    assert.equal(missing.reason, 'telegram_token_missing');
    for (const action of ['run', 'start', 'stop']) {
      const refusalReceipt = projectGatewayTest(gatewayActionRefusal(action));
      assert.equal(refusalReceipt.refused, true);
      assert.equal(refusalReceipt.reason, 'nnd_action_cli_only');
      assert.match(refusalReceipt.hint, /terminal/);
    }
    for (const action of ['deploy', 'install-local', 'refresh-managed']) {
      const searxngRefusal = searxngActionRefusal(action);
      assert.equal(searxngRefusal.refused, true);
      assert.equal(searxngRefusal.reason, 'nnd_action_cli_only');
    }
    assert.throws(() => gatewayActionRefusal('delete'), { code: 'nnd_action_triage_request_invalid' });
    for (const drift of [{ ...receipt, family: 'searxng' },
      { ...receipt, runtime: { running: 'yes' } },
      { ...receipt, config: { ...receipt.config, token_source: 7 } },
      null,
      { ...tested, ok: false },
      { ...tested, bot: { id: 7, username: 5 } },
      { ...tested, extra: true }]) {
      const project = 'bot' in (drift ?? {})
        ? projectGatewayTest
        : projectGatewayStatus;
      assert.throws(() => project(drift), (error) => error.code === 'nnd_action_triage_projection_invalid');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('searxng managed-status reuses the deployment authority and projects one grammar', async () => {
  const service = createNndSearxngStatusService({ paths: { managedSearxng: 'C:\\nna\\managed\\searxng' },
    installationId: 'install_triage', dataId: 'data_triage',
    deploymentFactory: () => ({ status: async () => ({ endpoint: 'http://127.0.0.1:8888/search',
      container: 'searxng', container_error: null, search: { ok: true } }) }) });
  const receipt = projectSearxngStatus(await service.managedStatus());
  assert.equal(receipt.status.container, 'searxng');
  assert.equal(receipt.status.search.ok, true);
  for (const drift of [{ ...receipt, family: 'gateway' },
    { ...receipt, status: { ...receipt.status, container: 7 } },
    { ...receipt, status: { ...receipt.status, search: { ok: 'yes' } } },
    { ...receipt, extra: true }, null]) {
    assert.throws(() => projectSearxngStatus(drift),
      (error) => error.code === 'nnd_action_triage_projection_invalid');
  }
  assert.throws(() => createNndSearxngStatusService({ paths: {},
    installationId: 'install_triage', dataId: 'data_triage' }),
  { code: 'nnd_action_triage_request_invalid' });
  assert.throws(() => createNndGatewayStatusService({ paths: {},
    installationId: 'install_triage', dataId: 'data_triage' }),
  { code: 'nnd_action_triage_request_invalid' });
  assert.throws(() => createNndGatewayTestService({ paths: {},
    installationId: 'install_triage', dataId: 'data_triage' }),
  { code: 'nnd_action_triage_request_invalid' });
});

async function server(t, services) {
  const instance = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0,
    nndRuntime: { getHost: () => ({ workspaceRoot: 'C:\\workspace' }),
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED, ...services });
  t.after(() => instance.close());
  return `${base}:${instance.address.port}`;
}

test('action triage HTTP serves status/test/managed-status and honest refusals', async t => {
  const gatewayStatus = createNndGatewayStatusService({ paths: {
    gatewayConfig: join(tmpdir(), 'triage-gateway.json'), gateway: tmpdir() },
    installationId: 'install_triage', dataId: 'data_triage',
    loadConfig: async () => ({ format_version: 1, enabled: true, token: null,
      token_env: 'NNA_TELEGRAM_BOT_TOKEN', workspace_root: 'C:\\ws', polling_timeout_seconds: 30,
      authorized_user_ids: [], updated_at: '2026-10-07T00:00:00.000Z' }),
    statusRunner: async () => ({ running: false }) });
  const gatewayTest = createNndGatewayTestService({ paths: {
    gatewayConfig: join(tmpdir(), 'triage-gateway.json') },
    installationId: 'install_triage', dataId: 'data_triage',
    loadConfig: async () => ({ format_version: 1, enabled: true, token: '123:test-token',
      token_env: 'NNA_TELEGRAM_BOT_TOKEN', workspace_root: 'C:\\ws', polling_timeout_seconds: 30,
      authorized_user_ids: [], updated_at: '2026-10-07T00:00:00.000Z' }),
    telegramFactory: () => ({ getMe: async () => ({ id: 9, username: 'probe_bot' }) }) });
  const searxng = createNndSearxngStatusService({ paths: {
    managedSearxng: 'C:\\nna\\managed\\searxng' },
    installationId: 'install_triage', dataId: 'data_triage',
    deploymentFactory: () => ({ status: async () => ({ endpoint: 'http://127.0.0.1:8888/search',
      container: 'stopped', container_error: null, search: { ok: false, error: 'connect ECONNREFUSED' } }) }) });
  const endpoint = await server(t, { nndGatewayStatusService: gatewayStatus,
    nndGatewayTestService: gatewayTest, nndSearxngStatusService: searxng });
  const call = async (suffix, { method = 'GET', body, bearer = token } = {}) => {
    const response = await fetch(`${endpoint}/v1/nnd/configuration/${suffix}`, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { authorization: bearer ? `Bearer ${bearer}` : '',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  assert.equal((await call('gateway/status', { bearer: null })).status, 401);
  assert.equal((await call('gateway/status', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call('gateway/status?x=1')).status, 400);
  const status = await call('gateway/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.family, 'gateway');
  assert.equal(status.body.runtime.running, false);
  const tested = await call('gateway/actions/test', { method: 'POST', body: {} });
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, true);
  assert.deepEqual(tested.body.bot, { id: 9, username: 'probe_bot' });
  for (const action of ['run', 'start', 'stop']) {
    const refusal = await call(`gateway/actions/${action}`, { method: 'POST', body: {} });
    assert.equal(refusal.status, 200, `${action} refuses honestly at 200`);
    assert.equal(refusal.body.refused, true);
    assert.equal(refusal.body.reason, 'nnd_action_cli_only');
  }
  const managed = await call('web-search/actions/managed-status');
  assert.equal(managed.status, 200);
  assert.equal(managed.body.family, 'searxng');
  assert.equal(managed.body.status.container, 'stopped');
  for (const action of ['deploy', 'install-local', 'refresh-managed']) {
    const searxngRefusal = await call(`web-search/actions/${action}`, { method: 'POST', body: {} });
    assert.equal(searxngRefusal.status, 200);
    assert.equal(searxngRefusal.body.reason, 'nnd_action_cli_only');
  }
  assert.equal((await call('gateway/actions/unknown', { method: 'POST', body: {} })).status, 404);
  assert.equal((await call('web-search/actions/unknown', { method: 'POST', body: {} })).status, 404);
  assert.equal(await dispatchNndActionTriageRequest({}, {}, { url: new URL('http://x/other'),
    principal: PERMITTED }), false, 'unrelated paths return false for the router chain');
});
