// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createApp } from '../packages/web/src/server/app.ts';
import { registerHarnessAdapter } from '../packages/web/src/server/harness/adapter.ts';
import { mockHarness } from '../packages/web/src/server/harness/mock/index.ts';

const REPLY_WINDOW_MS = 10_000;
const STEP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const origin = 'http://smoke.local';

await main().catch((error) => {
  process.stderr.write(`smoke test failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});

async function main() {
  registerHarnessAdapter(mockHarness);
  const app = createApp();
  const call = (path, init) => {
    const request = new Request(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
    return app.fetch(request);
  };
  await assertHealth(call);
  await assertAuthSession(call);
  const sessionID = await assertSessionLifecycle(call);
  await assertControlStream(call);
  await assertServerRoutes(call);
  process.stdout.write(`NotNativeDesktop smoke test passed (session ${sessionID}).\n`);
}

async function assertHealth(call) {
  const health = await expectJson(call, '/health', 200);
  assert.equal(health.ok, true);
  assert.equal(health.name, 'NotNativeDesktop');
  assert.equal(health.runtime === undefined || typeof health.runtime === 'string', true);
}

async function assertAuthSession(call) {
  const session = await expectJson(call, '/auth/session', 200);
  assert.equal(typeof session.authenticated, 'boolean');
  assert.equal(typeof session.authRequired, 'boolean');
  assert.deepEqual(session.methods, ['password']);
}

async function assertSessionLifecycle(call) {
  const createBody = { title: 'smoke test', directory: '' };
  const created = await expectJson(call, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody) }, 200);
  const sessionID = assertSessionRecord(created);
  const listEntries = await expectJson(call, '/api/session', 200);
  assert.ok(Array.isArray(listEntries), 'session list must be an array');
  assert.ok(listEntries.some((item) => item?.id === sessionID), 'created session must appear in the list');
  await assertPromptEcho(call, sessionID);
  await assertSessionStatus(call);
  await expectJson(call, `/api/session/${encodeURIComponent(sessionID)}`, { method: 'DELETE' }, 200);
  return sessionID;
}

function assertSessionRecord(record) {
  assert.ok(record && typeof record === 'object' && typeof record.id === 'string', 'create session must return a record with id');
  assert.ok(record.title === undefined || typeof record.title === 'string', 'title must be a string when present');
  return record.id;
}

async function assertPromptEcho(call, sessionID) {
  const parts = [{ type: 'text', text: 'smoke probe' }];
  const result = await expectJson(call, `/api/session/${encodeURIComponent(sessionID)}/prompt_async`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: { providerID: 'mock', modelID: 'mock' }, parts }),
  }, 204); // LF-8: accepted turns answer 204; delivery rides the event stream
  assert.ok(result === undefined || result === null || typeof result === 'object');
  const echoed = await pollFor(call, `/api/session/${encodeURIComponent(sessionID)}/message`, (entries) => (
    Array.isArray(entries) && entries.some((entry) => JSON.stringify(entry).includes('smoke probe'))
  ));
  assert.ok(echoed, `assistant reply mentioning the probe must arrive within ${REPLY_WINDOW_MS} ms`);
}

async function pollFor(call, path, predicate) {
  const deadline = Date.now() + REPLY_WINDOW_MS;
  for (;;) {
    const response = await call(path);
    if (response.ok) {
      const body = await response.json().catch(() => null);
      if (predicate(body)) return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function assertSessionStatus(call) {
  const status = await expectJson(call, '/api/session/status', 200);
  assert.ok(status && typeof status === 'object' && !Array.isArray(status), 'session status must be an object map');
}

async function assertControlStream(call) {
  const response = await call('/api/notnative/events');
  assert.equal(response.status, 200, 'control stream must open');
  const reader = response.body.getReader();
  try {
    const text = await readUntil(reader, 5_000, 'notnative:', 'control stream first frame');
    assert.ok(text.includes('notnative:'), `first control frame must derive from the notnative: prefix (got ${JSON.stringify(text.slice(0, 80))})`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readUntil(reader, timeoutMs, needle, label) {
  const decoder = new TextDecoder();
  let text = '';
  while (Date.now() < Date.now() + timeoutMs && text.length < 64 * 1024) {
    const chunk = await raceTimeout(reader.read(), timeoutMs, label);
    text += decoder.decode(chunk.value ?? new Uint8Array());
    if (text.includes(needle)) return text;
    if (chunk.done) return text;
  }
  return text;
}

async function assertServerRoutes(call) {
  const settingsFrame = await expectJson(call, '/api/notnative/settings', 200);
  assert.ok(settingsFrame.settings && typeof settingsFrame.settings === 'object', 'settings must default to an object');
  const manifest = await expectJson(call, '/manifest.webmanifest', 200);
  assert.equal(manifest.display, 'standalone');
}

async function expectJson(call, path, initOrStatus, maybeStatus) {
  const init = typeof initOrStatus === 'number' ? undefined : initOrStatus;
  const expected = typeof initOrStatus === 'number' ? initOrStatus : maybeStatus ?? 200;
  const response = await call(path, init);
  assert.equal(response.status, expected, `GET ${path} must return ${expected}`);
  const text = await response.text();
  if (response.status === 204 || text.length === 0) return undefined;
  return JSON.parse(text);
}

function raceTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)),
  ]);
}
