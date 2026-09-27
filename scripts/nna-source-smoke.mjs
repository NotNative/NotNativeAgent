// SPDX-License-Identifier: Apache-2.0
/** Explicit cross-repository smoke: NND routes -> adapter -> source NNA child. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeProviderRoute } from './smoke-provider-route.mjs'; import { probeGoal, probeGoalAudit, probeGoalAutonomousLoop } from './smoke-goal.mjs'; import { probeGoalEventRuntime } from './smoke-goal-runtime.mjs';
import { probeWalkthrough, walkthroughProviderReply } from './smoke-walkthrough.mjs';
const STEP_TIMEOUT_MS = 5_000;
const EXPECTED_REPLY = 'NND_SOURCE_REPLY';
const CHILD_TASK = 'Reply with NND_CHILD_REPLY.';
const CHILD_REPLY = 'NND_CHILD_REPLY';
const CHILD_STEER = 'Include NND_STEER_ACK in your final answer.';
const CHILD_STEER_ACK = 'NND_STEER_ACK';
const PARENT_REPLY = 'NND_PARENT_REPLY';
// The stream spans the origin-gate request and session creation, each with
// its own step deadline. Give the live subscription their combined budget.
const EVENT_TIMEOUT_MS = 30_000;
const source = process.argv[2] ? resolve(process.argv[2]) : null;
if (!source) {
  process.stderr.write('usage: node scripts/nna-source-smoke.mjs <NNA source directory>\n');
  process.exitCode = 2;
} else {
  await main(source).catch((error) => {
    process.stderr.write(`NNA source smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}

async function startProvider() {
  let completions = 0;
  const requests = [];
  let notifyChildRequest;
  let releaseChild;
  const childRequested = new Promise((resolve) => { notifyChildRequest = resolve; });
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  let heldChild = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/v1/models' && request.method === 'GET') {
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'test', context_length: 32768, max_output_tokens: 2048 }] }));
        return;
      }
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
        request.resume();
        response.writeHead(404); response.end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      completions += 1;
      const childRequest = body.messages?.some((message) => message.role === 'user' && message.content === CHILD_TASK);
      if (!heldChild && childRequest) {
        heldChild = true;
        notifyChildRequest();
        await childGate;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(providerReply(body));
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider listener has no port');
  return { server, port: address.port, completions: () => completions, requests: () => requests,
    childRequested, releaseChild };
}
function providerReply(body) {
  const messages = body.messages ?? [];
  const userText = messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
  let delta = { role: 'assistant', content: EXPECTED_REPLY };
  let finishReason = 'stop';
  if (messages[0]?.content?.startsWith('You audit progress of a coding agent')) delta = { role: 'assistant', content: JSON.stringify({ verdict: userText.includes('NND_LOOP_FINAL') ? 'complete' : 'continue', note: 'audit smoke note' }) };
  else if (walkthroughProviderReply(body)) delta = { role: 'assistant', content: walkthroughProviderReply(body) };
  else if (messages[0]?.content?.includes('isolated tool-permission decision')) {
    const review = JSON.parse(messages.find((message) => message.role === 'user')?.content ?? '{}');
    const intent = review.authenticatedIntent?.find((item) => item.content === 'Delegate the smoke task to a general sub-agent.');
    const approved = review.request?.toolName === 'agent_run' && review.request.args?.task === CHILD_TASK && intent;
    delta = { role: 'assistant', content: JSON.stringify({ outcome: approved ? 'approve' : 'deny_with_guidance',
      confidence: 1, reason_code: approved ? 'explicit_delegate_smoke' : 'no_matching_smoke_intent',
      authority_anchors: approved ? [intent.sequence] : [],
      ...(!approved ? { guidance: 'The smoke fixture grants only its exact delegated task.' } : {}) }) };
  } else if (userText.includes('Continue working toward the active session goal.')) delta = { role: 'assistant', content: 'NND_LOOP_FINAL' };
  else if (userText.includes(CHILD_TASK)) delta = { role: 'assistant',
    content: userText.includes(CHILD_STEER) ? `${CHILD_REPLY} ${CHILD_STEER_ACK}` : CHILD_REPLY };
  else if (userText.includes('Delegate the smoke task')) {
    const delegationResult = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'smoke_delegate_call');
    if (delegationResult) {
      const result = JSON.parse(delegationResult.content);
      const child = JSON.parse(result.content ?? '{}');
      delta = { role: 'assistant', content: result.tool_lifecycle_status === 'succeeded'
        && child.outcome === 'completed' && child.text?.includes(CHILD_REPLY)
        && child.text?.includes(CHILD_STEER_ACK)
        && /^agent_general_[A-Za-z0-9_-]+$/u.test(child.agent_id) ? PARENT_REPLY : 'NND_DELEGATION_FAILED' };
    } else {
      const searched = messages.some((message) => message.role === 'tool' && message.tool_call_id === 'smoke_search_call');
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'smoke_delegate_call', type: 'function',
        function: { name: searched ? 'agent_run' : 'tool_search',
          arguments: JSON.stringify(searched ? { type: 'general', task: CHILD_TASK } : { query: 'agent_run' }) } }] };
      if (!searched) delta.tool_calls[0].id = 'smoke_search_call';
      finishReason = 'tool_calls';
    }
  }
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`;
}
async function writeManifest(root, providerPort) {
  const config = join(root, 'config');
  const providerEndpoint = `http://127.0.0.1:${providerPort}/v1`;
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'durable', workspace_root: root,
    providers: [
      { id: 'primary', display_name: 'Primary', endpoint: providerEndpoint, model: 'test', trust_zone: 'loopback' },
      { id: 'delegated', display_name: 'Delegated', endpoint: providerEndpoint, model: 'test', trust_zone: 'loopback' },
    ],
    routes: { primary: { provider_id: 'primary', model: 'test' }, subagent: { provider_id: 'delegated', model: 'test' } },
    mcp_servers: smokeMcpServers(),
  }));
}
async function writeSmokeSkill(root) {
  await mkdir(join(root, 'skills', 'review'), { recursive: true });
  await writeFile(join(root, 'skills', 'review', 'SKILL.md'), [
    '---', 'id: smoke-review', 'version: 1', 'description: Review smoke work',
    'invocation: both', '---', 'SECRET_SKILL_BODY',
  ].join('\n'));
}
function smokeMcpServers() {
  const endpoint = 'http://127.0.0.1:9/mcp';
  return [{ id: 'smoke_memory', transport: 'streamable_http', enabled: false,
    endpoint, credential_env: 'SMOKE_SECRET_ENV' }];
}

async function probe(app, workspace, provider) {
  const call = (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
    ...init, signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  }));
  assert.equal((await json(call, '/api/global/health', 200)).healthy, true);
  const config = await json(call, '/api/config', 200);
  assert.deepEqual(config.nnd, {
    engine: 'nna', modelSelection: 'configured', primaryModel: { providerID: 'primary', modelID: 'test' },
  });
  assert.equal(JSON.stringify(config).includes('endpoint'), false, 'browser config must omit provider connection and secret metadata');
  const mcp = await json(call, '/api/v1/nnd/mcp', 200);
  assert.deepEqual(mcp, { version: 1, state: 'configured', servers: [{
    id: 'smoke_memory', transport: 'streamable_http', enabled: false, trusted: false,
  }] });
  assert.equal(JSON.stringify(mcp).includes('SMOKE_SECRET'), false, 'MCP inventory must omit secret references and destinations');
  const agents = await json(call, '/api/v1/nnd/agents', 200); assert.deepEqual(agents.route, { providerID: 'delegated', modelID: 'test' });
  assert.deepEqual(agents.roles.map((item) => item.id), ['general', 'planner', 'coder', 'tester', 'reviewer']);
  const profiles = await json(call, '/api/v1/provider-profiles', 200); assert.equal(profiles.profiles.length, 2);
  assert.deepEqual(profiles.configured_primary_route, { providerID: 'primary', modelID: 'test' }); assert.deepEqual(profiles.runtime_route, { providerID: 'primary', modelID: 'test' });
  const discovered = await json(call, '/api/v1/provider-profiles/primary/discover', { method: 'POST' }, 200);
  assert.deepEqual(discovered, { profile_id: 'primary', models: ['test'] });
  const tested = await json(call, '/api/v1/provider-profiles/primary/test', { method: 'POST' }, 200); assert.equal(tested.status, 'ready');
  await probeProviderRoute(call, json); await probeGoal(call, json); await probeGoalAudit(call, json);
  await probeGoalAutonomousLoop(call, json, workspace, provider.requests); await probeGoalEventRuntime(call, json, workspace, provider.requests);
  const skills = await json(call, '/api/v1/nnd/skills', 200);
  assert.ok(skills.skills.some((skill) => skill.id === 'smoke-review'));
  assert.equal(JSON.stringify(skills).includes('SECRET_SKILL_BODY'), false, 'skill inventory must omit instruction bodies');
  assert.equal(JSON.stringify(skills).includes('SKILL.md'), false, 'skill inventory must omit source paths');
  assert.deepEqual(await json(call, '/api/session?roots=true', 200), []);
  const eventAbort = new AbortController();
  const eventResponse = await app.fetch(new Request('http://nnd.local/api/global/event', {
    headers: { accept: 'text/event-stream' }, signal: AbortSignal.any([eventAbort.signal, AbortSignal.timeout(EVENT_TIMEOUT_MS)]),
  }));
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type') ?? '', /text\/event-stream/u);
  const reader = eventResponse.body.getReader();
  const nextEvent = eventReader(reader);
  try {
    assert.equal((await nextEvent()).payload.type, 'server.connected');
    return await probeSession(call, workspace, nextEvent, provider);
  } finally {
    eventAbort.abort();
    await reader.cancel().catch(() => {});
  }
}

async function probeSession(call, workspace, nextEvent, provider) {
  const blocked = await call('/api/session', { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(blocked.status, 403);
  const created = await json(call, '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Source bridge smoke' }),
  }, 201);
  assert.equal(created.directory, workspace);
  assert.deepEqual(created.metadata.nnd.configuredModel, { providerID: 'primary', modelID: 'test' });
  const id = created.id;
  assert.match(id, /^ses_[A-Za-z0-9_-]+$/u);
  const createdEvent = await nextEvent();
  assert.equal(createdEvent.payload.type, 'session.created');
  assert.equal(createdEvent.payload.properties.info.id, id);
  assert.equal(createdEvent.directory, workspace);
  assert.deepEqual((await json(call, '/api/session?roots=true', 200)).map((item) => item.id), [id]);
  assert.deepEqual(await json(call, '/api/session?roots=false', 200), []);
  assert.deepEqual(await json(call, `/api/session/${id}/children`, 200), []);
  assert.deepEqual(await json(call, `/api/session/${id}/message`, 200), []);
  const submitted = await call(`/api/session/${id}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: 'smoke_prompt', model: { providerID: 'primary', modelID: 'test' }, agent: 'nna', parts: [{ type: 'text', text: 'Reply with the smoke marker.' }] }),
  });
  assert.equal(submitted.status, 204);
  const authoredPhases = [];
  await withTimeout(waitForCompletedTurn(nextEvent, id, 'smoke_prompt', (event) => {
    if (event.payload?.type === 'session.updated' && event.payload.properties?.sessionID === id) {
      const phase = event.payload.properties.info?.metadata?.nnd?.turnState?.phase;
      if (phase) authoredPhases.push(phase);
    }
  }), 15_000, 'governed NNA turn did not reach a terminal activity');
  assert.ok(authoredPhases.includes('waiting_provider'), 'NNA did not publish its authored provider-wait phase through NND');
  await waitForReply(call, id, EXPECTED_REPLY);
  const firstActivity = await json(call, `/api/session/${id}/activity`, 200);
  assert.ok(firstActivity.some((row) => row.id === `${id}:turn:smoke_prompt` && row.status === 'completed'),
    'authenticated Activity snapshot did not retain the completed root turn');
  const settledMessages = await json(call, `/api/session/${id}/message`, 200);
  assert.deepEqual(settledMessages.map((message) => message.info.id), ['smoke_prompt', `${id}:message:1`],
    'NNA must project the submitted user ID for optimistic transcript reconciliation');
  assert.ok(settledMessages[1].info.time.completed >= settledMessages[1].info.time.created,
    'journal-backed assistant reply must be complete, not a perpetual live tail');
  await probeWalkthrough(call, json, id, provider.requests);
  const delegated = await call(`/api/session/${id}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: 'smoke_delegate', parts: [{ type: 'text', text: 'Delegate the smoke task to a general sub-agent.' }] }),
  });
  assert.equal(delegated.status, 204);
  await withTimeout(provider.childRequested, 10_000, 'NNA did not open a delegated provider request');
  const liveChild = await waitForChild(call, id);
  await waitForChildPhase(call, liveChild.id, 'waiting_provider');
  const activeCapability = await json(call, `/api/v1/nnd/sessions/${liveChild.id}/capabilities`, 200);
  assert.equal(activeCapability.capabilities.steer_subagent, true, 'active child was not granted steering');
  const steered = await json(call, `/api/v1/nnd/sessions/${liveChild.id}/steer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: 'smoke_steer', content: CHILD_STEER }),
  }, 202);
  assert.equal(steered.accepted, true, 'NNA did not accept child steering');
  provider.releaseChild();
  const childEvents = [];
  await withTimeout(waitForCompletedTurn(nextEvent, id, 'smoke_delegate', (event) => {
    if (event.payload?.type === 'session.created' && event.payload.properties?.info?.parentID === id) childEvents.push(event);
    if (event.payload?.type === 'nnd.activity' && event.payload.properties?.id?.endsWith(':turn')
      && event.payload.properties?.sessionID !== id) childEvents.push(event);
  }), 20_000, 'delegated NNA turn did not settle');
  await waitForReply(call, id, PARENT_REPLY);
  const children = await json(call, `/api/session/${id}/children`, 200);
  assert.equal(children.length, 1, 'delegation did not create one child session');
  const child = children[0];
  assert.equal(child.id, liveChild.id);
  assert.equal(child.parentID, id);
  assert.equal(child.directory, workspace);
  assert.deepEqual(child.metadata.nnd.configuredModel, { providerID: 'delegated', modelID: 'test' });
  assert.match(child.id, /^agent_general_[A-Za-z0-9_-]+$/u);
  assert.ok(childEvents.some((event) => event.payload.type === 'session.created'
    && event.payload.properties.info.id === child.id), 'child creation was not delivered on the live event stream');
  assert.ok(childEvents.some((event) => event.payload.type === 'nnd.activity'
    && event.payload.properties.id === `${child.id}:turn`
    && event.payload.properties.status === 'completed'
    && event.payload.properties.summary === 'Turn completed'), 'child completion was not delivered on the live event stream');
  const childActivity = await json(call, `/api/session/${child.id}/activity`, 200);
  assert.ok(childActivity.some((row) => row.id === `${child.id}:turn` && row.status === 'completed'),
    'authenticated Activity snapshot did not retain the completed child turn');
  assert.deepEqual((await json(call, '/api/session?roots=true', 200)).map((item) => item.id), [id]);
  assert.deepEqual((await json(call, '/api/session?roots=false', 200)).map((item) => item.id), [child.id]);
  const childMessages = await json(call, `/api/session/${child.id}/message`, 200);
  assert.ok(childMessages.some((message) => message.info?.role === 'assistant'
    && message.parts?.some((part) => part.type === 'text' && part.text?.includes(CHILD_STEER_ACK))),
  'completed child transcript was not projected through NND');
  assert.ok(childMessages.some((message) => message.info?.role === 'user'
    && message.parts?.some((part) => part.type === 'text' && part.text?.includes(CHILD_STEER))),
  'accepted child steering did not reach the child transcript');
  const capability = await json(call, `/api/v1/nnd/sessions/${child.id}/capabilities`, 200);
  assert.equal(capability.capabilities.steer_subagent, false, 'completed child retained steering authority');
  const lateSteer = await call(`/api/v1/nnd/sessions/${child.id}/steer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: 'late_steer', content: 'This must not be accepted.' }),
  });
  assert.equal(lateSteer.status, 409, 'NNA accepted steering after the child completed');
  const renamed = await json(call, `/api/session/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed smoke' }),
  }, 200);
  assert.equal(renamed.title, 'Renamed smoke');
  return { parentId: id, childId: child.id };
}

async function probeRestoredSession(app, { parentId, childId }) {
  const call = (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
    ...init, signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  }));
  assert.deepEqual((await json(call, '/api/session?roots=true', 200)).map((item) => item.id), [parentId]);
  assert.deepEqual((await json(call, '/api/session?roots=false', 200)).map((item) => item.id), [childId]);
  assert.deepEqual((await json(call, `/api/session/${parentId}/children`, 200)).map((item) => item.id), [childId]);
  assert.deepEqual((await json(call, `/api/session/${childId}`, 200)).metadata?.nnd?.turnState,
    { phase: 'idle' }, 'restored child must retain its completed idle fact');
  const messages = await json(call, `/api/session/${childId}/message`, 200);
  assert.ok(messages.some((message) => message.info?.role === 'assistant'
    && message.parts?.some((part) => part.text?.includes(CHILD_STEER_ACK))),
  'restarted NNA did not restore the completed child transcript through NND');
  const activity = await json(call, `/api/session/${childId}/activity`, 200);
  assert.ok(activity.some((row) => row.id === `${childId}:turn` && row.status === 'completed'),
    'restarted NNA did not restore completed child Activity through NND');
  const capability = await json(call, `/api/v1/nnd/sessions/${childId}/capabilities`, 200);
  assert.equal(capability.capabilities.steer_subagent, false, 'restored child was incorrectly steerable');
  assert.equal((await call(`/api/v1/nnd/sessions/${childId}/steer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: 'restarted_steer', content: 'Must stay read-only.' }),
  })).status, 409);
  assert.equal(await json(call, `/api/session/${parentId}`, { method: 'DELETE' }, 200), true);
  assert.deepEqual(await json(call, '/api/session?roots=true', 200), []);
  assert.equal((await call(`/api/session/${childId}/message`)).status, 404,
    'deleting restored parent did not revoke child transcript');
}

async function waitForChild(call, parentId) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const children = await json(call, `/api/session/${parentId}/children`, 200);
    if (children.length === 1) return children[0];
    if (Date.now() >= deadline) throw new Error('active delegated child did not appear in NND');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForChildPhase(call, childId, expected) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const child = await json(call, `/api/session/${childId}`, 200);
    if (child.metadata?.nnd?.turnState?.phase === expected) return;
    if (Date.now() >= deadline) throw new Error(`NNA child did not project ${expected} through NND`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForChildSnapshot(root, childId) {
  const path = join(root, 'sessions', 'nnd-contexts.json.children', `${Buffer.from(childId, 'utf8').toString('hex')}.json`);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { await access(path); return; }
    catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw new Error('completed child snapshot was not saved before restart');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCompletedTurn(nextEvent, id, promptId, observe = () => {}) {
  for (;;) {
    const event = await nextEvent();
    observe(event);
    if (event.payload?.type !== 'nnd.activity') continue;
    const activity = event.payload.properties;
    if (activity?.sessionID !== id || activity.id !== `${id}:turn:${promptId}`) continue;
    // NNA also labels cancelled/needs-input turns "completed" at the activity
    // transport layer; neither proves the provider reply finished normally.
    if (activity.status === 'completed') {
      assert.equal(activity.summary, 'Turn completed', 'governed NNA turn did not complete normally');
      return;
    }
    if (activity.status === 'failed') throw new Error('governed NNA turn failed after prompt acknowledgement');
  }
}

async function withTimeout(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForReply(call, id, marker) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const messages = await json(call, `/api/session/${id}/message`, 200);
    if (Array.isArray(messages) && messages.some((message) => message.info?.role === 'assistant'
      && message.parts?.some((part) => part.type === 'text' && part.text?.includes(marker)))) return;
    if (Date.now() >= deadline) throw new Error('governed NNA turn did not project the fake provider reply');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function eventReader(reader) {
  const decoder = new TextDecoder();
  let pending = '';
  return async () => {
    for (;;) {
      const split = pending.indexOf('\n\n');
      if (split >= 0) {
        const frame = pending.slice(0, split);
        pending = pending.slice(split + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        if (data) return JSON.parse(data);
        continue;
      }
      const part = await reader.read();
      if (part.done) throw new Error('NNA event stream ended before the expected event');
      pending += decoder.decode(part.value, { stream: true });
      if (pending.length > 65_536) throw new Error('NNA event frame exceeded smoke bound');
    }
  };
}

async function json(call, path, initOrStatus, expectedStatus) {
  const init = typeof initOrStatus === 'number' ? undefined : initOrStatus;
  const status = typeof initOrStatus === 'number' ? initOrStatus : expectedStatus;
  const response = await call(path, init);
  const body = await response.json().catch(() => null);
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
}

async function main(nnaSource) {
  const cli = join(nnaSource, 'src', 'cli.js');
  await access(cli);
  const root = await mkdtemp(join(tmpdir(), 'nnd-nna-source-smoke-'));
  let harness;
  let spawned;
  let provider;
  let operationFailed = false;
  try {
    provider = await startProvider();
    await writeManifest(root, provider.port);
    await writeSmokeSkill(root);
    // Import after the isolated data root is selected: server auth/settings
    // modules capture environment at import time.
    process.env.NOTNATIVE_DATA_DIR = join(root, 'nnd-data');
    process.env.NOTNATIVE_UI_PASSWORD = '';
    const [{ startLocalNnaHarness }, { createNnaHarnessAdapter }, { registerHarnessAdapter }, { createApp }] = await Promise.all([
      import('../packages/web/src/server/harness/nna-local.ts'),
      import('../packages/web/src/server/harness/nna.ts'),
      import('../packages/web/src/server/harness/adapter.ts'),
      import('../packages/web/src/server/app.ts'),
    ]);
    harness = await startLocalNnaHarness({
      command: process.execPath, commandArguments: [cli], dataRoot: root, workspaceId: 'local',
      spawnChild: (command, args, options) => { spawned = spawn(command, args, options); return spawned; },
    }).catch((error) => { throw new Error(`initial NNA start: ${error.message}`); });
    // A successful proxy request alone would not detect an accidentally
    // unauthenticated NNA endpoint. Verify the boundary before supplying the
    // launch credential to the adapter.
    const unauthenticated = await fetch(new URL('/global/health', harness.endpoint), {
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    assert.equal(unauthenticated.status, 401, 'NNA must reject requests without integration credentials');
    registerHarnessAdapter(createNnaHarnessAdapter({
      endpoint: harness.endpoint, token: harness.token, principal: harness.principal,
    }));
    const app = createApp();
    const sessions = await probe(app, root, provider);
    await waitForChildSnapshot(root, sessions.childId);
    const stopped = once(spawned, 'exit');
    harness.dispose();
    await withTimeout(stopped, 5_000, 'NNA did not stop for the restart smoke');
    harness = await startLocalNnaHarness({
      command: process.execPath, commandArguments: [cli], dataRoot: root, workspaceId: 'local',
      spawnChild: (command, args, options) => { spawned = spawn(command, args, options); return spawned; },
    }).catch((error) => { throw new Error(`NNA restart: ${error.message}`); });
    registerHarnessAdapter(createNnaHarnessAdapter({
      endpoint: harness.endpoint, token: harness.token, principal: harness.principal,
    }));
    await probeRestoredSession(createApp(), sessions);
    assert.ok(provider.completions() > 0, 'NNA did not call the isolated provider');
    assert.ok(provider.requests().some((request) => request.messages?.some((message) =>
      message.role === 'user' && typeof message.content === 'string'
      && message.content.includes('Reply with the smoke marker.'))),
    'NNA did not submit the user prompt to the isolated provider');
    assert.ok(provider.requests().some((request) => {
      if (!request.messages?.[0]?.content?.includes('isolated tool-permission decision')) return false;
      const message = request.messages.find((item) => item.role === 'user');
      if (!message) return false;
      const review = JSON.parse(message.content);
      return review.request?.toolName === 'agent_run' && review.request.args?.task === CHILD_TASK;
    }), 'NNA did not review the delegated agent_run request');
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    provider?.releaseChild();
    harness?.dispose();
    if (provider) {
      const closed = new Promise((resolve) => provider.server.close(resolve));
      provider.server.closeAllConnections();
      await closed;
    }
    const prefix = join(tmpdir(), 'nnd-nna-source-smoke-');
    if (!root.startsWith(prefix)) throw new Error('refusing to remove unexpected smoke directory');
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if (!operationFailed) throw error;
      process.stderr.write(`NNA source smoke cleanup also failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    }
  }
  process.stdout.write('NND↔NNA source smoke passed: authenticated bootstrap, capability inventories, provider diagnostics, model-only diff walkthrough, live events, governed prompt and delegation, restart-recovered child transcript, read-only steering, session lifecycle, attributed goal audits, direct and SSE-driven autonomous continuation, completion, and origin gate.\n');
}
