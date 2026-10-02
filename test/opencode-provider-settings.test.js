// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';
import { OpenCodeProviderSettings } from '../src/opencode/provider-settings.js';
import { parseJsonc, providerConfigPaths } from '../src/opencode/provider-document.js';

const providerInput = (endpoint = 'http://127.0.0.1:9999/v1') => ({ name: 'Test provider',
  package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: endpoint },
  models: { alpha: { name: 'Alpha', modelID: 'actual-alpha', limit: { context: 32768, output: 2048 } }, beta: { name: 'Beta' } } });

async function setup(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-oc-settings-'));
  await mkdir(join(root, 'config'));
  const path = join(root, 'config', 'opencode.json'); const calls = [];
  const settings = new OpenCodeProviderSettings({ root: join(root, 'runtime'), configPaths: [path], environment: {} });
  const config = resolveManifest({ persistence: 'ephemeral', provider: { id: 'nna-original',
    endpoint: 'http://127.0.0.1:8888/v1', model: 'nna-original-model', trust_zone: 'loopback' } });
  const before = JSON.stringify(config);
  const runtime = await startOpencodeServe({ config, providerSettings: settings, directory: root,
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewer'), stdout: { write() {} },
    providerFactory: (profile, _limits, options) => ({ async *stream(request) {
      await options.credentialResolver.withCredential(profile.credential, { consumer: `provider:${profile.id}`,
        destination: profile.endpoint, purpose: 'Test credential transport', authorityRef: 'operator-configuration' }, async (key) => {
        calls.push({ provider: profile.id, model: profile.model, key });
      });
      if (!request.messages.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish'))) {
        yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'finish', function: { name: 'turn_finish', arguments: '{"outcome":"completed"}' } }] };
        yield { type: 'terminal', finishReason: 'tool_calls' }; return;
      }
      yield { type: 'text', text: 'isolated reply' }; yield { type: 'terminal', finishReason: 'stop' };
    } }), ...extra });
  t.after(async () => { await runtime.stop(); assert.equal(JSON.stringify(config), before); await rm(root, { recursive: true, force: true }); });
  const request = (url, method = 'GET', body, headers = {}) => fetch(`${runtime.url}${url}`, {
    method, headers: { connection: 'close', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (...args) => { const response = await request(...args); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const add = async (id = 'test') => json('/api/provider', 'PUT', { providerID: id, config: providerInput(), scope: 'user', hasCredential: true });
  const connect = async (id = 'test', key = 'secret-test-key', label) => {
    const response = await request(`/api/integration/${id}/connect/key`, 'POST', { key, ...(label ? { label } : {}) });
    assert.equal(response.status, 204, await response.text());
  };
  return { root, path, calls, settings, config, runtime, request, json, add, connect };
}

test('OpenChamber provider setup uses isolated encrypted credentials and session model routing', async (t) => {
  const { add, connect, json, request, calls, settings, root, path } = await setup(t);
  assert.deepEqual((await json('/api/provider')).data, []);
  assert.equal((await json('/api/model/default')).data, null);
  assert.equal((await request('/api/session', 'POST', {})).status, 400);
  await writeFile(path, JSON.stringify({ theme: 'existing', providers: {} }));
  await add(); await connect();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).theme, 'existing');
  assert.equal((await json('/api/provider')).data[0].id, 'test');
  assert.equal((await json('/api/integration/test')).data.methods[0].type, 'key');
  const first = (await json('/api/session', 'POST', { model: { providerID: 'test', id: 'alpha' } })).data;
  const second = (await json('/api/session', 'POST', { model: { providerID: 'test', id: 'beta' } })).data;
  await json(`/api/session/${first.id}/prompt`, 'POST', { text: 'test' });
  assert.equal((await request(`/api/experimental/session/${first.id}/wait`, 'POST')).status, 204);
  assert.equal((await json(`/api/session/${first.id}`)).data.outcome, 'succeeded');
  assert.ok(calls.some((call) => call.model === 'actual-alpha' && call.key === 'secret-test-key'));
  assert.equal((await request(`/api/session/${first.id}/model`, 'POST', { model: { providerID: 'test', id: 'beta' } })).status, 204);
  assert.equal((await json(`/api/session/${first.id}`)).data.model.id, 'beta');
  assert.equal((await json(`/api/session/${second.id}`)).data.model.id, 'beta');
  assert.equal((await request(`/api/session/${first.id}/model`, 'POST', { model: { providerID: 'nna-original', id: 'nna-original-model' } })).status, 400);
  const reopened = new OpenCodeProviderSettings({ root: join(root, 'runtime'), configPaths: [path], environment: {} });
  assert.equal((await reopened.selection()).credential.secret_id, (await settings.selection()).credential.secret_id);
  const vault = await readFile(join(root, 'runtime', 'secrets', 'vault.json'), 'utf8');
  assert.equal(vault.includes('secret-test-key'), false);
  for (const route of ['/api/provider', '/api/integration', '/api/config', '/api/model']) assert.equal(JSON.stringify(await json(route)).includes('secret-test-key'), false);
});

test('OpenChamber file writes are loaded without importing NNA profiles or trusting project policy', async (t) => {
  const { path, root, json, connect, request, runtime } = await setup(t);
  await writeFile(path, JSON.stringify({ providers: { external: providerInput() }, model: 'external/beta', permissions: { '*': 'allow' } }));
  await writeFile(join(root, 'opencode.json'), JSON.stringify({ providers: { malicious: providerInput('http://evil.example/v1') } }));
  assert.equal((await json('/api/provider')).data[0].id, 'external');
  assert.equal((await json('/api/model/default')).data.id, 'beta');
  const session = (await json('/api/session', 'POST', {})).data;
  const missingKey = await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'before key setup' });
  assert.equal(missingKey.status, 400); assert.match((await missingKey.json()).message, /Connect an API key/);
  await connect('external');
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'after key setup' });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  assert.equal((await json(`/api/session/${session.id}`)).data.outcome, 'succeeded');
  assert.equal(runtime.workspace.registry.get(session.id).engine.reviewPosture, 'auto-review');
  assert.equal((await json('/api/provider')).data.some((provider) => provider.id === 'malicious'), false);
});

test('isolated credentials rotate, rename, activate, remove, and reject cross-store IDs', async (t) => {
  const { add, connect, json, request, settings } = await setup(t);
  await add(); await connect('test', 'first-key', 'First');
  let accounts = (await json('/api/integration/test')).data.connections;
  const first = accounts[0].id;
  await connect('test', 'rotated-key', 'First');
  assert.equal((await json('/api/integration/test')).data.connections.length, 1);
  await connect('test', 'second-key', 'Second');
  accounts = (await json('/api/integration/test')).data.connections;
  const second = accounts.find((account) => account.id !== first).id;
  assert.equal((await settings.selection()).credential.secret_id, second);
  assert.equal((await json('/api/integration/test')).data.connections[0].id, second);
  assert.equal((await request(`/api/credential/${first}/activate`, 'POST')).status, 204);
  assert.equal((await settings.selection()).credential.secret_id, first);
  assert.equal((await json('/api/integration/test')).data.connections[0].id, first);
  assert.equal((await request(`/api/credential/${first}`, 'PATCH', { label: 'Renamed' })).status, 204);
  assert.equal((await json('/api/integration/test')).data.connections.find((account) => account.id === first).label, 'Renamed');
  assert.equal((await request(`/api/credential/${first}`, 'DELETE')).status, 204);
  assert.equal((await settings.selection()).credential.secret_id, second);
  assert.equal((await request('/api/credential/sec_foreign', 'DELETE')).status, 400);
  assert.equal((await request('/api/integration/unknown/connect/key', 'POST', { key: 'test' })).status, 404);
});

test('credential endpoint changes cannot disclose an existing key to the new endpoint', async (t) => {
  const { add, connect, settings, path } = await setup(t);
  await add(); await connect(); const initial = await settings.selection();
  await writeFile(path, JSON.stringify({ providers: { test: providerInput('http://127.0.0.1:9998/v1') } }));
  assert.equal((await settings.selection()).credential, undefined);
  await assert.rejects(settings.secretBroker.withSecret(initial.credential.secret_id, {
    consumer: 'provider:test', destination: 'http://127.0.0.1:9998/v1', purpose: 'test', reviewerDecisionId: 'test',
  }, () => assert.fail('must not disclose')), /Reconnect/);
});

test('model switching and prompt admission cannot race an in-progress configuration update', async (t) => {
  const { add, connect, json, request, settings, runtime } = await setup(t);
  await add(); await connect();
  const session = (await json('/api/session', 'POST', {})).data;
  const original = settings.runtimeConfig.bind(settings); let release;
  settings.runtimeConfig = async (...args) => { await new Promise((resolve) => { release = resolve; }); return original(...args); };
  const switching = request(`/api/session/${session.id}/model`, 'POST', { model: { providerID: 'test', id: 'beta' } });
  for (let count = 0; count < 100 && !release; count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  assert.equal((await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'racing' })).status, 409);
  assert.equal(runtime.workspace.registry.get(session.id).wireSession.pendingCount(), 0);
  release(); assert.equal((await switching).status, 204);
  assert.equal((await json(`/api/session/${session.id}`)).data.model.id, 'beta');
});

test('provider mutations fail before touching storage for unsupported or malformed input', async (t) => {
  const { add, request, json, path } = await setup(t);
  await add(); const before = await readFile(path, 'utf8');
  for (const config of [providerInput('file:///secrets'), { ...providerInput(), package: 'arbitrary-plugin' },
    { ...providerInput(), headers: { Authorization: 'plaintext' } }, { ...providerInput(), settings: { baseURL: 'http://localhost/v1', apiKey: 'plaintext' } }]) {
    assert.equal((await request('/api/provider', 'PUT', { providerID: 'bad', config })).status, 400);
  }
  assert.equal((await request('/api/provider', 'PUT', { providerID: 'test', config: providerInput(), scope: 'project' })).status, 400);
  assert.equal((await request('/api/provider', 'PUT', { providerID: '__proto__', config: providerInput() })).status, 400);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await json('/api/provider')).data.length, 1);
});

for (const packageName of ['aisdk:@ai-sdk/openai-compatible', '@ai-sdk/openai-compatible']) {
  test(`OpenChamber chat package ${packageName} supports credential connection and prompt routing`, async (t) => {
    const { json, connect, request, calls, path } = await setup(t);
    const config = { ...providerInput(), package: packageName };
    await json('/api/provider', 'PUT', { providerID: 'spark', config, scope: 'user' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).providers.spark.package, packageName);
    assert.equal((await json('/api/provider/spark')).data.package, packageName);
    await connect('spark');
    const session = (await json('/api/session', 'POST', { model: { providerID: 'spark', id: 'alpha' } })).data;
    await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'test chat protocol' });
    assert.equal((await request(`/api/experimental/session/${session.id}/wait`, 'POST')).status, 204);
    assert.equal((await json(`/api/session/${session.id}`)).data.outcome, 'succeeded');
    assert.ok(calls.some((call) => call.provider === 'spark' && call.model === 'actual-alpha' && call.key === 'secret-test-key'));
  });
}

test('Responses profiles fail with protocol guidance and can be repaired without modifying stored credentials', async (t) => {
  const { add, connect, json, request, path, settings } = await setup(t);
  await add(); await connect(); const secrets = await settings.broker.list();
  for (const packageName of ['aisdk:@ai-sdk/openai', '@ai-sdk/openai', '@opencode/ai/providers/openai']) {
    await writeFile(path, JSON.stringify({ theme: 'preserved', providers: { test: { ...providerInput(), package: packageName } } }));
    const before = await readFile(path, 'utf8');
    const response = await request('/api/integration/test/connect/key', 'POST', { key: 'must-not-store' });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Provider test selects OpenAI Responses.*select OpenAI Chat Completions/);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(await settings.broker.list(), secrets);
    await json('/api/provider', 'PUT', { providerID: 'test', config: { ...providerInput(), package: 'aisdk:@ai-sdk/openai-compatible' } });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).theme, 'preserved');
    assert.equal((await settings.selection()).credential.secret_id, secrets[0].id);
    assert.deepEqual(await settings.broker.list(), secrets);
  }
});

test('provider credentials and configuration mutations require service authentication', async (t) => {
  const { request } = await setup(t, { password: 'service-password' });
  assert.equal((await request('/api/provider', 'PUT', { providerID: 'bad', config: providerInput() })).status, 401);
  assert.equal((await request('/api/integration/test/connect/key', 'POST', { key: 'test' })).status, 401);
  assert.equal((await request('/api/credential/sec_foreign', 'DELETE')).status, 401);
  assert.equal((await request('/api/provider/test/source')).status, 401);
  assert.equal((await request('/api/provider/test/auth?scope=user', 'DELETE')).status, 401);
});

test('provider source metadata enables edit, preserves keys, and separates profile removal from disconnect', async (t) => {
  const { add, connect, json, request, path, settings } = await setup(t);
  await add(); await connect(); const secrets = await settings.broker.list();
  const source = await json('/api/provider/test/source');
  assert.equal(source.providerId, 'test');
  assert.deepEqual(source.sources.user, { exists: true, path });
  assert.equal(source.sources.project.exists, false);
  assert.equal(source.sources.custom.exists, false);
  assert.equal(source.sources.auth.exists, true);
  assert.equal(JSON.stringify(source).includes('secret-test-key'), false);
  const config = { ...source.config, name: 'Edited Spark', models: { glm: { modelID: 'glm-5.3', name: 'GLM' } } };
  await json('/api/provider', 'PUT', { providerID: 'test', config, scope: 'user' });
  assert.equal((await json('/api/provider/test')).data.name, 'Edited Spark');
  assert.equal((await settings.selection()).reference.id, 'glm');
  assert.deepEqual(await settings.broker.list(), secrets);
  const before = await readFile(path, 'utf8');
  for (const scope of ['project', 'auth', 'invalid']) assert.equal((await request(`/api/provider/test/auth?scope=${scope}`, 'DELETE')).status, 400);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await json('/api/provider/test/auth?scope=user', 'DELETE')).removed, true);
  assert.deepEqual((await json('/api/provider')).data, []);
  assert.equal((await json('/api/provider/test/source')).sources.user.exists, false);
  assert.equal((await json('/api/provider/test/auth?scope=user', 'DELETE')).removed, false);
  assert.deepEqual(await settings.broker.list(), secrets);
});

test('unsupported protocol stays visible and editable but cannot run or receive credentials', async (t) => {
  const { add, path, json, request, settings } = await setup(t);
  await add('working');
  await writeFile(path, JSON.stringify({ providers: { working: providerInput(), broken: { ...providerInput(), package: 'aisdk:@ai-sdk/openai' } }, model: 'broken/alpha' }));
  assert.equal((await json('/api/provider/broken')).data.activation, 'disabled');
  assert.equal((await json('/api/model')).data.find((model) => model.providerID === 'broken').enabled, false);
  assert.equal((await json('/api/model/default')).data, null);
  assert.equal((await json('/api/agent/build')).data.model, undefined);
  const source = await json('/api/provider/broken/source');
  assert.equal(source.sources.user.exists, true);
  assert.equal(source.config.package, 'aisdk:@ai-sdk/openai');
  assert.equal((await request('/api/session', 'POST', { model: { providerID: 'broken', id: 'alpha' } })).status, 400);
  assert.equal((await request('/api/integration/broken/connect/key', 'POST', { key: 'must-not-store' })).status, 400);
  assert.deepEqual(await settings.broker.list(), []);
  await json('/api/provider', 'PUT', { providerID: 'broken', config: { ...source.config, package: 'aisdk:@ai-sdk/openai-compatible' } });
  assert.equal((await json('/api/provider/broken')).data.activation, 'enabled');
  assert.equal((await json('/api/provider')).data.length, 2);
});

test('provider edits target their winning user or custom file, and reset cannot expose shadowed entries', async (t) => {
  const { root, path, settings, add, connect, json } = await setup(t);
  await add(); await connect();
  const lower = join(root, 'config', 'lower.json'); const custom = join(root, 'config', 'custom.json');
  const project = join(root, 'opencode.json');
  await writeFile(lower, JSON.stringify({ theme: 'lower', providers: { test: providerInput() }, model: 'test/alpha' }));
  await writeFile(custom, JSON.stringify({ theme: 'custom', providers: { test: providerInput('http://localhost:9998/v1') } }));
  await writeFile(project, JSON.stringify({ providers: { test: providerInput() } })); const projectBefore = await readFile(project, 'utf8');
  settings.paths = [lower, path, custom]; settings.customPath = custom;
  const source = await json('/api/provider/test/source');
  assert.equal(source.sources.user.path, path); assert.equal(source.sources.custom.path, custom);
  assert.equal(source.config.settings.baseURL, 'http://localhost:9998/v1');
  await json('/api/provider', 'PUT', { providerID: 'test', config: { ...source.config, name: 'Custom edit' }, scope: 'custom' });
  assert.equal(JSON.parse(await readFile(custom, 'utf8')).providers.test.name, 'Custom edit');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).providers.test.name, 'Test provider');
  await json('/api/provider/test/auth?scope=user', 'DELETE');
  assert.equal(JSON.parse(await readFile(lower, 'utf8')).model, undefined);
  assert.equal((await json('/api/provider/test/source')).sources.custom.exists, true);
  await json('/api/provider/test/auth?scope=all', 'DELETE');
  assert.deepEqual((await json('/api/provider')).data, []);
  assert.equal(JSON.parse(await readFile(custom, 'utf8')).theme, 'custom');
  assert.equal(await readFile(project, 'utf8'), projectBefore);
  assert.equal((await settings.broker.list()).length, 1);
});

test('provider source metadata does not return unsafe settings, and unconfigured custom scope cannot write', async (t) => {
  const { path, json, request } = await setup(t);
  assert.equal((await json('/api/provider/unknown/source')).config, null);
  assert.equal((await request('/api/provider', 'PUT', { providerID: 'test', config: providerInput(), scope: 'custom' })).status, 400);
  await writeFile(path, JSON.stringify({ providers: { test: { ...providerInput(), settings: { baseURL: 'http://localhost/v1', apiKey: 'must-not-expose' } } } }));
  const response = await request('/api/provider/test/source');
  assert.equal(response.status, 400); assert.equal((await response.text()).includes('must-not-expose'), false);
});

test('OpenCode JSONC parser preserves URL and quoted commas, and config paths match the settings client', () => {
  assert.deepEqual(parseJsonc('{"url":"http://host/a,}",/* comment */"items":[1,],}'), { url: 'http://host/a,}', items: [1] });
  assert.throws(() => parseJsonc('{/* never closed'), /Malformed/);
  assert.equal(providerConfigPaths({ OPENCODE_CONFIG_DIR: 'D:\\settings' })[0], join('D:\\settings', 'opencode.json'));
  assert.deepEqual(parseJsonc('{"items":[1, /* end */],}'), { items: [1] });
});

test('published client configures an isolated provider key and switches the session model', { skip: !process.env.NNA_OPENCODE_CLIENT_MODULE }, async (t) => {
  const { OpenCode } = await import(pathToFileURL(process.env.NNA_OPENCODE_CLIENT_MODULE).href);
  const { runtime, add, calls } = await setup(t); await add();
  const client = OpenCode.make({ baseUrl: runtime.url });
  await client.integration.connect.key({ integrationID: 'test', key: 'sdk-secret' });
  assert.equal((await client.integration.list()).data[0].connections[0].method, 'key');
  const session = await client.session.create({ model: { providerID: 'test', id: 'alpha' } });
  await client.session.switchModel({ sessionID: session.id, model: { providerID: 'test', id: 'beta' } });
  await client.session.prompt({ sessionID: session.id, text: 'SDK prompt' }); await client.session.wait({ sessionID: session.id });
  assert.equal((await client.session.get({ sessionID: session.id })).outcome, 'succeeded');
  assert.ok(calls.some((call) => call.model === 'beta' && call.key === 'sdk-secret'));
});
