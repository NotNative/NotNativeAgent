// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';
import { ProtocolWriter, runHeadless } from '../src/headless.js';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { JournalStore } from '../src/store.js';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const EMPTY_HOOK_ROOT = join(process.cwd(), '.nna-test-hooks-none');

test('AC-HEAD-07 output writer bounds queued bytes and resumes after backpressure', async () => {
  const output = new PassThrough({ highWaterMark: 1 });
  const writer = new ProtocolWriter(output, { maxQueuedBytes: 256, maxLineBytes: 128 });
  const writes = Array.from({ length: 12 }, (_, index) => writer.write({ type: 'stream_delta', text: `delta-${index}` }));
  assert.ok(writer.pendingBytes <= 256);
  output.resume();
  await Promise.all(writes);
  await writer.close();
  output.destroy();
});

test('AC-HEAD-07 broken output becomes a typed failure', async () => {
  const output = new Writable({ write(_chunk, _encoding, next) {
    const error = new Error('pipe closed');
    error.code = 'EPIPE';
    next(error);
  } });
  const writer = new ProtocolWriter(output);
  await assert.rejects(writer.write({ type: 'turn_result', outcome: 'completed' }), { code: 'output_broken_pipe' });
  assert.equal(writer.failed.code, 'output_broken_pipe');
});

test('AC-HEAD-07 broken host pipe finalizes active headless work', async () => {
  let providerFinalized = false;
  const provider = { async *stream() {
    try {
      yield { type: 'text', text: 'will-break-output' };
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } finally { providerFinalized = true; }
  } };
  const initialize = {
    version: '1.0', type: 'initialize', request_id: 'pipe-init',
    manifest: { persistence: 'ephemeral', provider: {
      endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback',
    } },
  };
  const input = new PassThrough();
  input.write(`${JSON.stringify(initialize)}\n`);
  input.write(`${JSON.stringify({ version: '1.0', type: 'submit', request_id: 'pipe-submit', content: 'work' })}\n`);
  const output = new Writable({ write(chunk, _encoding, next) {
    if (!String(chunk).includes('"type":"stream_delta"')) return next();
    const error = new Error('pipe closed');
    error.code = 'EPIPE';
    return next(error);
  } });
  let diagnostics = '';
  await runHeadless(input, output, new Writable({ write(chunk, _encoding, next) {
    diagnostics += chunk;
    next();
  } }), { providerFactory: () => provider, hookRoot: EMPTY_HOOK_ROOT });
  assert.equal(providerFinalized, true);
  assert.match(diagnostics, /output_broken_pipe/u);
  input.destroy();
  process.exitCode = undefined;
});

test('AC-PROV-01/AC-PROV-02 discovers local models and preserves fragmented SSE text', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'local-model', context_length: 32768, max_output_tokens: 2048 }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"private-thought","content":"hel"},"finish_reason":null}]}\n');
    response.write('\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const provider = new OpenAICompatibleProvider({
    endpoint: `http://127.0.0.1:${port}/v1`, credentialEnv: null, model: 'local-model',
    capabilities: { streaming: true, tools: 'unknown', images: 'unknown' },
  }, { maxOutputBytes: 100_000 });
  const capabilities = await provider.capabilities(new AbortController().signal);
  assert.deepEqual(capabilities.models, ['local-model']);
  assert.equal(capabilities.model, 'local-model');
  assert.equal(capabilities.contextLimitTokens, 32768);
  assert.equal(capabilities.outputLimitTokens, 2048);
  const items = [];
  for await (const item of provider.stream({ model: 'local-model', messages: [] }, new AbortController().signal)) {
    items.push(item);
  }
  assert.equal(items.filter((item) => item.type === 'text').map((item) => item.text).join(''), 'hello');
  assert.equal(items.filter((item) => item.type === 'reasoning').map((item) => item.text).join(''), 'private-thought');
  assert.equal(items.filter((item) => item.type === 'terminal').length, 1);
});

test('AC-PROV-01 capability metadata is byte-bounded before JSON parsing', async () => {
  const provider = new OpenAICompatibleProvider({
    endpoint: 'http://127.0.0.1:1/v1', credentialEnv: null, model: 'fixture', capabilities: {},
  }, {}, {
    fetch: async () => new Response(`{"data":[],"padding":"${'x'.repeat(1_048_576)}"}`, {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(provider.capabilities(new AbortController().signal), { code: 'provider_metadata_too_large' });
});

test('AC-PROV-04 provider credentials resolve per adapter and never enter request content or errors', async () => {
  const previousA = process.env.NNA_PROVIDER_A;
  const previousB = process.env.NNA_PROVIDER_B;
  process.env.NNA_PROVIDER_A = 'secret-a-value'; process.env.NNA_PROVIDER_B = 'secret-b-value';
  const seen = [];
  const fetch = async (url, options) => {
    seen.push({ url, authorization: options.headers.authorization, body: options.body ?? '' });
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    for (const [id, credentialEnv] of [['a', 'NNA_PROVIDER_A'], ['b', 'NNA_PROVIDER_B']]) {
      const adapter = new OpenAICompatibleProvider({
        id, endpoint: `https://${id}.example.test/v1`, credentialEnv,
        capabilities: { streaming: true, tools: true },
      }, { maxOutputBytes: 4096 }, { fetch });
      for await (const _event of adapter.stream({ model: id, messages: [{ role: 'user', content: 'hello' }] }, new AbortController().signal)) { /* consume */ }
    }
    assert.deepEqual(seen.map((item) => item.authorization), ['Bearer secret-a-value', 'Bearer secret-b-value']);
    assert.equal(seen[0].body.includes('secret-a-value'), false);
    assert.equal(seen[1].body.includes('secret-b-value'), false);
    const missing = new OpenAICompatibleProvider({
      endpoint: 'https://missing.example.test/v1', credentialEnv: 'NNA_PROVIDER_MISSING', capabilities: {},
    }, {}, { fetch });
    await assert.rejects(async () => {
      for await (const _event of missing.stream({ model: 'm', messages: [] }, new AbortController().signal)) { /* consume */ }
    }, (error) => error.code === 'missing_credential' && !error.message.includes('secret'));
  } finally {
    if (previousA === undefined) delete process.env.NNA_PROVIDER_A; else process.env.NNA_PROVIDER_A = previousA;
    if (previousB === undefined) delete process.env.NNA_PROVIDER_B; else process.env.NNA_PROVIDER_B = previousB;
  }
});

test('AC-PROV-02 structured-output constraints cross the generic provider boundary', async () => {
  const seen = [];
  const provider = new OpenAICompatibleProvider({
    endpoint: 'http://127.0.0.1:1/v1', credentialEnv: null, capabilities: {}, model: 'fixture',
  }, { maxOutputBytes: 4096 }, { fetch: async (_url, options) => {
    seen.push(JSON.parse(options.body));
    return new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  } });
  const responseFormat = {
    type: 'json_schema', json_schema: {
      name: 'decision', strict: true,
      schema: { type: 'object', additionalProperties: false },
    },
  };
  for await (const _event of provider.stream({
    model: 'fixture', messages: [], responseFormat,
  }, new AbortController().signal)) { /* consume */ }
  assert.deepEqual(seen[0].response_format, responseFormat);
  assert.deepEqual(seen[0].stream_options, { include_usage: true });
  let called = false;
  const invalid = new OpenAICompatibleProvider({
    endpoint: 'http://127.0.0.1:1/v1', credentialEnv: null, capabilities: {}, model: 'fixture',
  }, { maxOutputBytes: 4096 }, { fetch: async () => { called = true; throw new Error('unreachable'); } });
  await assert.rejects(async () => {
    for await (const _event of invalid.stream({
      model: 'fixture', messages: [], responseFormat: { type: 'vendor_magic' },
    }, new AbortController().signal)) { /* consume */ }
  }, { code: 'provider_response_format_invalid' });
  assert.equal(called, false);
});

test('AC-FAIL-08/AC-PROV-01 rejects invalid usage and types provider context rejection', async () => {
  const profile = { endpoint: 'http://127.0.0.1:1/v1', credentialEnv: null, capabilities: {}, model: 'fixture' };
  const invalidUsage = new OpenAICompatibleProvider(profile, { maxOutputBytes: 4096 }, {
    fetch: async () => new Response(
      'data: {"choices":[],"usage":{"prompt_tokens":null}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  });
  await assert.rejects(async () => {
    for await (const _event of invalidUsage.stream({ model: 'fixture', messages: [] }, new AbortController().signal)) { /* consume */ }
  }, { code: 'provider_usage_invalid' });

  const oversized = new OpenAICompatibleProvider(profile, { maxOutputBytes: 4096 }, {
    fetch: async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(async () => {
    for await (const _event of oversized.stream({ model: 'fixture', messages: [] }, new AbortController().signal)) { /* consume */ }
  }, { code: 'provider_context_limit', retryable: false });
});

test('AC-PROV-01 types in-band SSE errors without exposing provider-controlled text', async () => {
  const remoteSecret = 'remote-error-secret-value';
  const provider = new OpenAICompatibleProvider({
    endpoint: 'http://127.0.0.1:1/v1', credentialEnv: null, capabilities: {}, model: 'fixture',
  }, { maxOutputBytes: 4096 }, { fetch: async () => new Response(
    `data: ${JSON.stringify({ error: { message: remoteSecret } })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  ) });
  await assert.rejects(async () => {
    for await (const _event of provider.stream({ model: 'fixture', messages: [] }, new AbortController().signal)) { /* consume */ }
  }, (error) => {
    assert.equal(error.code, 'provider_rejected');
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, new RegExp(remoteSecret, 'u'));
    return true;
  });
});

test('normalizes context overflow variants from local OpenAI-compatible hosts', async () => {
  const variants = [
    { error: { code: 'context_window_exceeded' } },
    { error: { message: "This model's maximum context length is 262144 tokens. However, you requested 270000 tokens." } },
    { error: { message: 'input length exceeds maximum context length' } },
    { error: { type: 'invalid_request_error', message: 'the prompt is too long for the available context window' } },
    { message: 'request exceeds the available context size; enable context shift' },
    { error: { message: 'KV cache has insufficient capacity for the requested tokens' } },
  ];
  const profile = { endpoint: 'http://127.0.0.1:1/v1', credentialEnv: null, capabilities: {}, model: 'fixture' };
  for (const body of variants) {
    const provider = new OpenAICompatibleProvider(profile, { maxOutputBytes: 4096 }, {
      fetch: async () => Response.json(body, { status: 400 }),
    });
    await assert.rejects(async () => {
      for await (const _event of provider.stream({ model: 'fixture', messages: [] }, new AbortController().signal)) { /* consume */ }
    }, { code: 'provider_context_limit' });
  }
});

test('normalizes an in-band streaming context overflow', async () => {
  const provider = new OpenAICompatibleProvider({
    endpoint: 'http://127.0.0.1:1/v1', credentialEnv: null, capabilities: {}, model: 'fixture',
  }, { maxOutputBytes: 4096 }, { fetch: async () => new Response(
    'data: {"error":{"message":"input length exceeds maximum context length"}}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  ) });
  await assert.rejects(async () => {
    for await (const _event of provider.stream({ model: 'fixture', messages: [] }, new AbortController().signal)) { /* consume */ }
  }, { code: 'provider_context_limit' });
});

test('AC-HEAD-01/AC-OBS-02 emits protocol-only lifecycle and correlated local metadata logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-headless-observed-'));
  const logPath = join(root, 'runtime.ndjson');
  class Provider {
    async *stream() {
      yield { type: 'text', text: 'done' };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
    }
  }
  const commands = [
    {
      version: '1.0', type: 'initialize', request_id: 'init-1',
      manifest: { persistence: 'ephemeral', provider: {
        endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback',
      } },
    },
    { version: '1.0', type: 'submit', request_id: 'submit-1', content: 'finish' },
    { version: '1.0', type: 'shutdown', request_id: 'shutdown-1' },
  ];
  const input = Readable.from((async function* commandStream() {
    yield `${JSON.stringify(commands[0])}\n`;
    yield `${JSON.stringify(commands[1])}\n`;
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield `${JSON.stringify(commands[2])}\n`;
  }()));
  let stdout = '';
  let stderr = '';
  const output = new Writable({ write(chunk, _encoding, next) { stdout += chunk; next(); } });
  const diagnostics = new Writable({ write(chunk, _encoding, next) { stderr += chunk; next(); } });
  await runHeadless(input, output, diagnostics, {
    providerFactory: () => new Provider(), hookRoot: EMPTY_HOOK_ROOT, logPath,
  });
  const records = stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((item) => item.type), [
    'initialized', 'accepted', 'stream_delta', 'turn_result', 'shutdown_complete',
  ]);
  assert.equal(records.filter((item) => item.type === 'turn_result').length, 1);
  assert.equal(stderr, '');
  const logged = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(logged.some((item) => item.code === 'initialized' && item.request_id === 'init-1'), true);
  assert.equal(logged.some((item) => item.code === 'turn_result' && item.turn_id), true);
  assert.equal(logged.some((item) => item.code === 'shutdown_complete'), true);
  assert.doesNotMatch(JSON.stringify(logged), /finish|done/u);
  await rm(root, { recursive: true, force: true });
});

test('AC-HEAD-04 concurrent cancel finalizes before shutdown completion', async () => {
  const provider = { async *stream(_request, signal) {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'text', text: 'late' };
    yield { type: 'terminal' };
  } };
  const commands = [
    {
      version: '1.0', type: 'initialize', request_id: 'cancel-init',
      manifest: { persistence: 'ephemeral', provider: {
        endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback',
      } },
    },
    { version: '1.0', type: 'submit', request_id: 'cancel-submit', content: 'Wait' },
    { version: '1.0', type: 'cancel', request_id: 'cancel-control' },
    { version: '1.0', type: 'shutdown', request_id: 'cancel-shutdown' },
  ];
  const input = Readable.from((async function* commandStream() {
    yield `${JSON.stringify(commands[0])}\n${JSON.stringify(commands[1])}\n`;
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield `${JSON.stringify(commands[2])}\n`;
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield `${JSON.stringify(commands[3])}\n`;
  }()));
  let stdout = '';
  const output = new Writable({ write(chunk, _encoding, next) { stdout += chunk; next(); } });
  const diagnostics = new Writable({ write(_chunk, _encoding, next) { next(); } });
  await runHeadless(input, output, diagnostics, { providerFactory: () => provider, hookRoot: EMPTY_HOOK_ROOT });
  const records = stdout.trim().split('\n').map(JSON.parse);
  const terminal = records.find((item) => item.type === 'turn_result');
  assert.equal(terminal.outcome, 'cancelled');
  assert.ok(records.findIndex((item) => item.type === 'turn_result') < records.findIndex((item) => item.type === 'shutdown_complete'));
  assert.equal(records.filter((item) => item.type === 'stream_delta').length, 0);
});

test('AC-HEAD-02/AC-HEAD-11/AC-TURN-06 headless auto-review stays correlated without permission controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-headless-review-correlation-'));
  let step = 0;
  let reviewStarted;
  let releaseReview;
  const started = new Promise((resolve) => { reviewStarted = resolve; });
  const release = new Promise((resolve) => { releaseReview = resolve; });
  const semanticReviewer = { async review() {
    reviewStarted(); await release;
    return { outcome: 'approve', confidence: 1, reason_code: 'exact_user_intent' };
  } };
  const provider = { async *stream() {
    step += 1;
    if (step === 1) {
      const args = JSON.stringify({ executable: process.execPath, args: ['--version'] });
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'headless-process', function: { name: 'process.run', arguments: args } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text', text: 'done' }; yield { type: 'terminal' };
  } };
  const initialize = {
    version: '1.0', type: 'initialize', request_id: 'busy-init',
    manifest: { persistence: 'ephemeral', workspace_root: root, provider: {
      endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback',
    } },
  };
  const input = Readable.from((async function* commands() {
    yield `${JSON.stringify(initialize)}\n${JSON.stringify({ version: '1.0', type: 'submit', request_id: 'primary-submit', content: 'Run Node.js with --version' })}\n`;
    await started;
    const busy = JSON.stringify({ version: '1.0', type: 'submit', request_id: 'busy-submit', content: 'Another request' });
    yield `${busy}\n${busy}\n`;
    releaseReview();
    await new Promise((resolve) => setTimeout(resolve, 40));
    yield `${JSON.stringify({ version: '1.0', type: 'shutdown', request_id: 'busy-stop' })}\n`;
  }()));
  let stdout = '';
  await runHeadless(input, new Writable({ write(chunk, _encoding, next) { stdout += chunk; next(); } }),
    new Writable({ write(_chunk, _encoding, next) { next(); } }), {
      providerFactory: () => provider, semanticReviewer, hookRoot: EMPTY_HOOK_ROOT,
      storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewer'),
    });
  const records = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(records.some((item) => item.type === 'accepted' && item.request_id === 'busy-submit' && item.reason === 'busy'), true);
  assert.equal(records.some((item) => item.type === 'accepted' && item.request_id === 'busy-submit' && item.duplicate === true), true);
  const review = records.find((item) => item.type === 'review_status');
  assert.equal(review.outcome, 'approve');
  assert.ok(review.tool_request_id);
  assert.equal(records.some((item) => item.type === 'permission_request'), false);
});

test('AC-HEAD-09/AC-CONF-05 host manifest provenance is durable, secret-safe, and ceilings capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-headless-manifest-'));
  let providerRequest;
  let providerStartedResolve;
  const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
  const provider = { async *stream(request) {
    providerRequest = request;
    providerStartedResolve();
    yield { type: 'text', text: 'bounded' };
    yield { type: 'terminal' };
  } };
  const commands = [
    {
      version: '1.0', type: 'initialize', request_id: 'host-init', execution_manifest_id: 'nno-run-1',
      host_origin: 'local-nno', session_id: 'host-session',
      host_identity: {
        subject_id: 'user-1', scope: 'chat', platform_role: 'user',
        permissions: ['module.read'], workspace_ids: ['workspace-1'], group_ids: [], module_ids: ['inventory'],
      },
      manifest: {
        format_version: 1, persistence: 'durable', workspace_root: root,
        allowed_capabilities: [], disconnect_policy: 'cancel',
        attachments: { enabled: true }, memory: { enabled: true },
        provider: {
          endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback',
          credential_env: 'NNA_TEST_HOST_SECRET',
        },
        mission: {
          id: 'nightly-check', revocation_id: 'nightly-check-v1', outcome: 'Answer without tools.',
          not_before: '2020-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z',
          resources: ['workspace'], targets: ['scope:workspace'], side_effects: ['read_only'],
          credential_refs: ['NNA_TEST_HOST_SECRET'],
          bounds: { max_turns: 2, max_tool_calls: 0, max_duration_ms: 60000 },
          termination: { suspend_on: ['review_denial'], terminate_on: ['budget_exhaustion', 'expiration', 'disconnect'] },
        },
      },
    },
    { version: '1.0', type: 'submit', request_id: 'host-submit', content: 'answer without tools' },
    { version: '1.0', type: 'steer', request_id: 'host-steer', content: 'not allowed' },
    { version: '1.0', type: 'shutdown', request_id: 'host-shutdown' },
  ];
  let stdout = '';
  try {
    const input = Readable.from((async function* hostCommands() {
      yield `${JSON.stringify(commands[0])}\n${JSON.stringify(commands[1])}\n`;
      await providerStarted;
      yield `${JSON.stringify(commands[2])}\n${JSON.stringify(commands[3])}\n`;
    }()));
    const output = new Writable({ write(chunk, _encoding, next) { stdout += chunk; next(); } });
    const diagnostics = new Writable({ write(_chunk, _encoding, next) { next(); } });
    await runHeadless(input, output, diagnostics, {
      providerFactory: () => provider, hookRoot: EMPTY_HOOK_ROOT,
      storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewer'),
    });
    const records = stdout.trim().split('\n').map(JSON.parse);
    const initialized = records.find((item) => item.type === 'initialized');
    assert.ok(initialized, stdout);
    assert.deepEqual({
      tools: initialized.capabilities.tools, steering: initialized.capabilities.steering,
      attachments: initialized.capabilities.attachments, memory: initialized.capabilities.memory,
    }, { tools: false, steering: false, attachments: false, memory: false });
    assert.equal(initialized.execution_manifest.id, 'nno-run-1');
    assert.equal(initialized.execution_manifest.hostOrigin, 'local-nno');
    assert.equal(initialized.execution_manifest.principal, 'authenticated-stdio-host');
    assert.deepEqual(initialized.execution_manifest.hostIdentity, {
      subjectId: 'user-1', scope: 'chat', platformRole: 'user', permissions: ['module.read'],
      workspaceIds: ['workspace-1'], groupIds: [], moduleIds: ['inventory'],
    });
    assert.equal(initialized.execution_manifest.primaryRoute.credentialRef, 'NNA_TEST_HOST_SECRET');
    assert.equal(initialized.mission.id, 'nightly-check');
    assert.deepEqual(initialized.mission.targets, ['scope:workspace']);
    assert.doesNotMatch(stdout, /seeded-host-secret/u);
    assert.equal(initialized.execution_manifest.primaryRoute.model, 'fixture');
    assert.ok(providerRequest, stdout);
    assert.deepEqual(providerRequest.tools, []);
    assert.equal(records.some((item) => item.code === 'capability_not_allowed'), true);
    const journal = (await readFile(join(root, 'sessions', 'host-session.journal.ndjson'), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    const created = journal.find((item) => item.type === 'session_created').payload;
    assert.equal(created.executionManifest.id, 'nno-run-1');
    assert.equal(created.executionManifest.hostOrigin, 'local-nno');
    assert.deepEqual(created.executionManifest.allowedCapabilities, []);
    assert.equal(created.mission.revocationId, 'nightly-check-v1');

    let mismatchOutput = '';
    const mismatchInput = Readable.from([`${JSON.stringify({
      ...commands[0], request_id: 'host-reinit', execution_manifest_id: 'different-run',
    })}\n`]);
    const beforeMismatch = await readFile(join(root, 'sessions', 'host-session.journal.ndjson'), 'utf8');
    await runHeadless(
      mismatchInput,
      new Writable({ write(chunk, _encoding, next) { mismatchOutput += chunk; next(); } }),
      new Writable({ write(_chunk, _encoding, next) { next(); } }),
      {
        providerFactory: () => provider, hookRoot: EMPTY_HOOK_ROOT,
        storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewer'),
      },
    );
    assert.equal(mismatchOutput.trim().split('\n').map(JSON.parse).at(-1).code, 'execution_manifest_mismatch');
    assert.equal(await readFile(join(root, 'sessions', 'host-session.journal.ndjson'), 'utf8'), beforeMismatch);
    process.exitCode = undefined;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('AC-SESS-11 host-created durable sessions wait for their original application policy on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-host-resume-'));
  const sessions = join(root, 'sessions');
  const sessionId = 'host-policy-session';
  const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' };
  const hostConfig = resolveManifest({
    persistence: 'durable', workspace_root: root, provider,
    application_system_prompt: 'host-only application policy', allowed_capabilities: [],
  }, { principal: 'authenticated-stdio-host', executionManifestId: 'host-run', hostOrigin: 'nno' });
  const store = new JournalStore(sessions, sessionId);
  try {
    await store.open();
    await store.append('session_created', {
      sessionId, configurationVersion: 1, executionManifest: hostConfig.executionManifest,
    });
    await store.close();
    const localConfig = resolveManifest({ persistence: 'durable', workspace_root: root, provider });
    const engine = new SessionEngine({
      config: localConfig, sessionId, storeRoot: sessions,
      reviewerRoot: join(root, 'reviewer'), hookRoot: EMPTY_HOOK_ROOT,
      providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
    });
    await assert.rejects(engine.initialize(), (error) => {
      assert.equal(error.code, 'execution_manifest_required');
      assert.match(error.message, /original authenticated host execution manifest/u);
      return true;
    });
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
