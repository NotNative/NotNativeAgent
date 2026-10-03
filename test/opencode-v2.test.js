// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/opencode/v2-schemas.json', import.meta.url)));

function schemaCheck(value, schema) {
  if (schema.$ref) return schemaCheck(value, fixture.components.schemas[schema.$ref.split('/').at(-1)]);
  if (schema.anyOf) return schema.anyOf.some((item) => schemaCheck(value, item));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0)
    && value.every((item, index) => schemaCheck(item, schema.prefixItems?.[index] ?? schema.items ?? {}));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (schema.required?.some((key) => !(key in value))) return false;
    return Object.entries(value).every(([key, item]) => schema.properties?.[key]
      ? schemaCheck(item, schema.properties[key]) : schema.additionalProperties === false ? false
        : typeof schema.additionalProperties === 'object' ? schemaCheck(item, schema.additionalProperties) : true);
  }
  if (schema.type === 'integer') return Number.isInteger(value) && value >= (schema.minimum ?? -Infinity);
  if (schema.type && typeof value !== schema.type) return false;
  return !schema.pattern || new RegExp(schema.pattern, 'u').test(value);
}

function contract(name, value) {
  assert.ok(schemaCheck(value, fixture.components.schemas[name]), `${name}: ${JSON.stringify(value)}`);
}

class Provider {
  async *stream(request) {
    if (!request.messages.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish'))) {
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'finish', function: { name: 'turn_finish', arguments: '{"outcome":"completed"}' } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' }; return;
    }
    yield { type: 'text', text: 'hello ' }; yield { type: 'text', text: 'v2' };
    yield { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 4 } };
    yield { type: 'terminal', finishReason: 'stop' };
  }
}

async function fixtureServer(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-v2-'));
  const config = resolveManifest({ persistence: 'ephemeral', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback',
  } });
  const runtime = await startOpencodeServe({ config, directory: root, storeRoot: join(root, 's'), reviewerRoot: join(root, 'r'),
    providerFactory: () => new Provider(), stdout: { write() {} }, ...extra });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const request = (path, method = 'GET', value, headers = {}) => fetch(`${runtime.url}${path}`, {
    method, headers: { connection: 'close', 'content-type': 'application/json', ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const json = async (...args) => { const response = await request(...args); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  return { runtime, request, json, root };
}

test('legacy creation cannot supply internal v2 session authority fields', async (t) => {
  const { json, runtime } = await fixtureServer(t);
  const session = await json('/session', 'POST', {
    title: 'Legacy', ocId: 'ses_injected', runtimeDirectory: 'D:\\unauthorized', metadata: { injected: true },
  });
  assert.notEqual(session.id, 'ses_injected');
  const record = runtime.workspace.registry.get(session.id);
  assert.notEqual(record.engine.config.workspaceRoot, 'D:\\unauthorized');
});

test('v2 prompt accepts text beyond the old 65536-character ceiling', async (t) => {
  const { json, request } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const prompt = await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'a'.repeat(70_000) });
  assert.equal(prompt.status, 200, await prompt.text());
  assert.equal((await request(`/api/experimental/session/${session.id}/wait`, 'POST')).status, 204);
  assert.equal((await json(`/api/session/${session.id}`)).data.outcome, 'succeeded');
});

test('v2 discovery, configured catalogs, and session CRUD conform to published schemas', async (t) => {
  const { json, request, root } = await fixtureServer(t);
  const info = await json('/api/info'); contract('ServerInfo', info); assert.equal(info.version, '2.0.21');
  contract('Location.PublicInfo', await json('/api/location'));
  for (const [path, name] of [['agent', 'Agent.Info'], ['model', 'Model.Info'], ['provider', 'Provider.Info']]) {
    const response = await json(`/api/${path}`); assert.deepEqual(response.location, { directory: root });
    contract(name, response.data[0]);
  }
  contract('Project', (await json('/api/project'))[0]);
  contract('Config.Entry', (await json('/api/config'))[0]);
  const session = (await json('/api/session', 'POST', { id: 'ses_client-id', title: 'First', metadata: { label: 'test' } })).data;
  contract('Session.Info', session); assert.equal(session.id, 'ses_client-id');
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { title: 'Renamed' })).status, 204);
  assert.equal((await json(`/api/session/${session.id}`)).data.title, 'Renamed');
  assert.equal((await json(`/api/session?directory=${encodeURIComponent(root)}`)).data.length, 1);
  assert.equal((await json('/api/session?directory=elsewhere')).data.length, 0);
  assert.equal((await request(`/api/session/${session.id}`, 'DELETE')).status, 204);
  const missing = await request(`/api/session/${session.id}`);
  assert.equal(missing.status, 404); assert.equal((await missing.json())._tag, 'SessionNotFoundError');
});

test('v2 prompt admits client IDs, emits native events, and projects message history', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${runtime.url}/api/event`, { signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events = [];
  const collected = (async () => {
    while (!controller.signal.aborted) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (events.some((event) => event.type === 'session.execution.succeeded')) { await reader.cancel(); break; }
    }
  })();
  const receipt = (await json(`/api/session/${session.id}/prompt`, 'POST', { id: 'msg_from-client', text: 'hello', metadata: { source: 'test' } })).data;
  contract('Session.Inbox.User', receipt); assert.equal(receipt.id, 'msg_from-client');
  assert.equal((await request(`/api/experimental/session/${session.id}/wait`, 'POST')).status, 204);
  await collected;
  const messages = await json(`/api/session/${session.id}/message?order=asc`);
  assert.equal(messages.data.length, 2);
  contract('Session.Message.User', messages.data[0]); contract('Session.Message.Assistant', messages.data[1]);
  assert.equal(messages.data[1].content[0].text, 'hello v2');
  assert.equal(messages.data[0].id, receipt.id);
  assert.deepEqual(messages.data[0].metadata, { source: 'test' });
  assert.equal(events[0].type, 'server.connected');
  assert.ok(events.some((event) => event.type === 'session.text.delta'));
  assert.ok(events.some((event) => event.type === 'session.text.ended' && event.data.text === 'hello v2'));
  const sequence = events.filter((event) => event.durable).map((event) => event.durable.seq);
  assert.equal(new Set(sequence).size, sequence.length); assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b));
  assert.ok(events.every((event) => !('payload' in event) && !('properties' in event)));
  assert.deepEqual((await json('/api/session/active')).data, {});
  contract('SessionInterruptResponse', await json(`/api/session/${session.id}/interrupt`, 'POST'));
});

test('v2 rejects malformed and unsupported requests before engine submission', async (t) => {
  const { json, request, runtime } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', {})).data;
  for (const input of [null, [], { text: 'x', files: [{}] }, { text: 'x', permissions: [] }, { text: 'x', resume: false }, { text: 'x', model: { id: 'other' } }]) {
    const denied = await request(`/api/session/${session.id}/prompt`, 'POST', input);
    assert.equal(denied.status, 400); assert.equal((await denied.json())._tag, 'InvalidRequestError');
  }
  assert.equal(runtime.workspace.registry.get(session.id).wireSession.messages().length, 0);
  assert.equal((await request('/api/session', 'POST', { permissions: [] })).status, 400);
  assert.equal((await request('/api/session?cursor=garbage')).status, 400);
  assert.equal((await request('/api/session?limit=-2')).status, 400);
  assert.equal((await request(`/api/session/${session.id}/permission`, 'POST', { action: 'allow' })).status, 404);
});

test('v2 auth covers discovery, event streaming, and mutations', async (t) => {
  const { request } = await fixtureServer(t, { password: 'fixture-password' });
  for (const [path, method] of [['/api/info', 'GET'], ['/api/event', 'GET'], ['/api/session', 'POST']]) {
    const denied = await request(path, method, method === 'POST' ? {} : undefined);
    assert.equal(denied.status, 401); assert.equal((await denied.json())._tag, 'UnauthorizedError');
  }
  const response = await request('/api/info', 'GET', undefined, { authorization: `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}` });
  assert.equal(response.status, 200);
});

test('v2 session pagination keeps filters and supports both directions', async (t) => {
  const { json } = await fixtureServer(t);
  for (let index = 0; index < 3; index += 1) await json('/api/session', 'POST', { title: `page-${index}` });
  const first = await json('/api/session?limit=2&order=asc');
  const next = await json(`/api/session?limit=2&cursor=${first.cursor.next}`);
  assert.equal(next.data.length, 1); assert.equal(new Set([...first.data, ...next.data].map((item) => item.id)).size, 3);
  const previous = await json(`/api/session?limit=2&cursor=${next.cursor.previous}`);
  assert.deepEqual(previous.data, first.data);
});

test('v2 pagination stays anchored when sessions are inserted and requires recovery after anchor deletion', async (t) => {
  const { json, request } = await fixtureServer(t);
  for (let index = 0; index < 3; index += 1) await json('/api/session', 'POST', { title: `page-${index}` });
  const first = await json('/api/session?limit=2&order=desc');
  await json('/api/session', 'POST', { title: 'newest' });
  const next = await json(`/api/session?limit=2&cursor=${first.cursor.next}`);
  assert.equal(next.data.length, 1);
  assert.equal(new Set([...first.data, ...next.data].map((item) => item.id)).size, 3);
  assert.equal((await request(`/api/session/${first.data.at(-1).id}`, 'DELETE')).status, 204);
  const invalid = await request(`/api/session?limit=2&cursor=${first.cursor.next}`);
  assert.equal(invalid.status, 400); assert.equal((await invalid.json())._tag, 'InvalidCursorError');
});

test('v2 rejected selections, invalid directories, and partial updates do not change session state', async (t) => {
  const { json, request, runtime, root } = await fixtureServer(t);
  const session = (await json('/api/session', 'POST', { id: 'ses_client', title: 'Original' })).data;
  assert.equal(runtime.workspace.registry.get(session.id).engine.config.workspaceRoot, root);
  assert.equal((await request('/api/session', 'POST', { id: session.id })).status, 409);
  assert.equal((await request('/api/session', 'POST', { location: { directory: join(root, 'missing') } })).status, 400);
  assert.equal((await request(`/api/session/${session.id}/model`, 'POST', { model: { id: 'other', providerID: 'test' } })).status, 400);
  assert.equal((await request(`/api/session/${session.id}/agent`, 'POST', { agent: 'plan' })).status, 400);
  assert.equal((await request(`/api/session/${session.id}`, 'PATCH', { title: 'Changed', metadata: 12 })).status, 400);
  assert.equal((await json(`/api/session/${session.id}`)).data.title, 'Original');
  assert.equal((await request('/api/location', 'GET', undefined, { 'x-opencode-directory': '%invalid' })).status, 400);
});

class QuestionProvider extends Provider {
  calls = 0;
  async *stream(request) {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'question', function: {
        name: 'question', arguments: JSON.stringify({ questions: [{ question: 'Choose channel', options: [{ label: 'stable' }, { label: 'beta' }] }] }),
      } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' }; return;
    }
    yield* super.stream(request);
  }
}

async function waitForForm(json, sessionID) {
  for (let index = 0; index < 200; index += 1) {
    const forms = (await json(`/api/session/${sessionID}/form`)).data;
    if (forms.length) return forms[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Question did not become a form');
}

test('v2 forms recover pending questions and enforce ownership, choices, and single settlement', { timeout: 20_000 }, async (t) => {
  const provider = new QuestionProvider();
  const { json, request } = await fixtureServer(t, { providerFactory: () => provider });
  const first = (await json('/api/session', 'POST', {})).data;
  const other = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${first.id}/prompt`, 'POST', { text: 'ask me' });
  const form = await waitForForm(json, first.id); contract('Form.Info', form);
  assert.equal((await json('/api/form')).data[0].id, form.id);
  contract('Form.Detail', (await json(`/api/session/${first.id}/form/${form.id}`)).data);
  assert.equal((await request(`/api/session/${other.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'stable' } })).status, 404);
  assert.equal((await request(`/api/session/${first.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'invalid' } })).status, 400);
  assert.equal((await json(`/api/session/${first.id}/form`)).data.length, 1);
  assert.equal((await request(`/api/session/${first.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'stable' } })).status, 204);
  assert.equal((await request(`/api/session/${first.id}/form/${form.id}/reply`, 'POST', { answer: { question_0: 'stable' } })).status, 409);
  assert.equal((await request(`/api/experimental/session/${first.id}/wait`, 'POST')).status, 204);
  assert.deepEqual((await json(`/api/session/${first.id}/form`)).data, []);
  assert.equal((await json(`/api/session/${first.id}`)).data.outcome, 'succeeded');
});

test('v2 interruption cancels the active question and prevents queued execution', { timeout: 20_000 }, async (t) => {
  const provider = new QuestionProvider();
  const { json, request } = await fixtureServer(t, { providerFactory: () => provider });
  const session = (await json('/api/session', 'POST', {})).data;
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'ask me' });
  const form = await waitForForm(json, session.id);
  await json(`/api/session/${session.id}/prompt`, 'POST', { text: 'queued', id: 'msg_queued', delivery: 'queue' });
  assert.equal((await request(`/api/session/${session.id}/prompt`, 'POST', { text: 'steer', delivery: 'steer' })).status, 409);
  assert.equal((await json('/api/session/active')).data[session.id].type, 'running');
  assert.deepEqual(await json(`/api/session/${session.id}/interrupt`, 'POST'), { interrupted: true });
  await request(`/api/experimental/session/${session.id}/wait`, 'POST');
  assert.equal(provider.calls, 1);
  assert.deepEqual((await json(`/api/session/${session.id}/inbox`)).data, []);
  assert.equal((await json(`/api/session/${session.id}`)).data.outcome, 'interrupted');
  assert.equal((await json(`/api/session/${session.id}/form/${form.id}`)).data.state.status, 'cancelled');
  assert.ok((await json(`/api/session/${session.id}/message`)).data.every((message) => message.id !== 'msg_queued'));
});

test('published OpenCode client completes the v2 chat lifecycle', { skip: !process.env.NNA_OPENCODE_CLIENT_MODULE, timeout: 20_000 }, async (t) => {
  const { OpenCode } = await import(pathToFileURL(process.env.NNA_OPENCODE_CLIENT_MODULE).href);
  const { runtime, root } = await fixtureServer(t);
  const client = OpenCode.make({ baseUrl: runtime.url, headers: { 'x-opencode-directory': encodeURIComponent(root) } });
  assert.equal((await client.server.info()).version, '2.0.21');
  assert.equal((await client.location.get()).directory, root);
  assert.equal((await client.model.list()).data.length, 1);
  assert.deepEqual((await client.permission.request.list()).data, []);
  const events = client.event.subscribe({ signal: AbortSignal.timeout(15_000) })[Symbol.asyncIterator]();
  assert.equal((await events.next()).value.type, 'server.connected');
  const collect = (async () => {
    const result = [];
    for (let count = 0; count < 100; count += 1) {
      const item = await events.next(); if (item.done) break;
      result.push(item.value);
      if (item.value.type === 'session.execution.succeeded') break;
    }
    await events.return(); return result;
  })();
  const session = await client.session.create({ title: 'Official client' });
  assert.equal(session.location.directory, root);
  const admitted = await client.session.prompt({ sessionID: session.id, id: 'msg_sdk', text: 'hello' });
  assert.equal(admitted.id, 'msg_sdk');
  await client.session.wait({ sessionID: session.id });
  const stream = await collect;
  assert.ok(stream.some((event) => event.type === 'session.text.ended' && event.data.text === 'hello v2'));
  assert.equal((await client.message.list({ sessionID: session.id, order: 'asc' })).data[1].content[0].text, 'hello v2');
  await client.session.remove({ sessionID: session.id });
  assert.deepEqual((await client.session.list()).data, []);
});
