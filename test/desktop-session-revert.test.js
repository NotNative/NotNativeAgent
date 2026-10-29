// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { recoverJournal } from '../src/store.js';
import { runDesktopSessionRevert, runDesktopSessionUnrevert, settleDesktopTimelinesForShutdown } from '../src/desktop-session-revert.js';
import { TypedSessionEngine as SessionEngine } from './typed-provider-fixture.js';

const principal = { subjectId: 'u_test', platformRole: 'operator', permissions: ['desktop.session.submit'], workspaceIds: [],
  groupIds: [], traceId: 'trace_revert', issuedAt: '2026-10-11T00:00:00Z', requestId: 'req_revert_probe' };

test('revert and unrevert require a durable session journal', async () => {
  const context = { sessionId: 'ephemeral', liveTurn: null,
    engine: { store: null, active: null, transcript: [] } };
  await assert.rejects(() => runDesktopSessionRevert(context, { messageID: 'ephemeral:message:0' }),
    (error) => error.code === 'desktop_revert_unavailable');
  await assert.rejects(() => runDesktopSessionUnrevert(context),
    (error) => error.code === 'desktop_revert_unavailable');
});

test('a pending revert excludes other timeline operations and releases its latch', async () => {
  let enterRead, releaseRead;
  const entered = new Promise((resolve) => { enterRead = resolve; });
  const blocked = new Promise((resolve) => { releaseRead = resolve; });
  const records = [
    { type: 'turn_accepted', payload: { turnId: 'turn-1' } },
    { type: 'message', payload: { type: 'message', role: 'user', content: 'one', turnId: 'turn-1' } },
  ];
  const appended = [];
  const context = { sessionId: 'race', liveTurn: null, engine: {
    active: null, transcript: [records[1].payload],
    store: { async readRecords() { enterRead(); await blocked; return { records }; },
      async append(type, payload) { appended.push({ type, payload }); } },
  } };
  const first = runDesktopSessionRevert(context, { messageID: 'race:message:0' });
  await entered;
  await assert.rejects(() => runDesktopSessionRevert(context, { messageID: 'race:message:0' }),
    (error) => error.code === 'desktop_revert_busy');
  await assert.rejects(() => runDesktopSessionUnrevert(context), (error) => error.code === 'desktop_revert_busy');
  assert.deepEqual(appended, []);
  releaseRead();
  await first;
  assert.equal(context.timelineMutation, false);
  assert.deepEqual(appended.map((item) => item.type), ['revert_point']);
});

test('shutdown wait is bounded when a journal read never settles', async () => {
  const context = { timelineMutation: new Promise(() => {}) };
  await assert.rejects(() => settleDesktopTimelinesForShutdown([context], 1),
    (error) => error.code === 'desktop_revert_busy');
  assert.equal(context.timelineShutdown, true);
  assert.equal(context.closing, true);
});

test('revert replay failures do not append a marker', async () => {
  const user = { type: 'message', role: 'user', content: 'one', turnId: 'turn-1' };
  const records = [{ type: 'turn_accepted', payload: { turnId: 'turn-1' } },
    { type: 'message', payload: user }, { type: 'turn_outcome', payload: {} }];
  const appended = [];
  const context = { sessionId: 'invalid', liveTurn: null, engine: {
    active: null, transcript: [user], store: {
      async readRecords() { return { records }; },
      async append(type) { appended.push(type); },
    },
  } };
  await assert.rejects(() => runDesktopSessionRevert(context, { messageID: 'invalid:message:0' }),
    (error) => error.code === 'session_history_invalid');
  assert.deepEqual(appended, []);
  assert.deepEqual(context.engine.transcript, [user]);
  assert.equal(context.timelineMutation, false);
  records.push({ type: 'revert_point', payload: { reverted_turn_ids: ['turn-1'] } });
  await assert.rejects(() => runDesktopSessionUnrevert(context),
    (error) => error.code === 'session_history_invalid');
  assert.deepEqual(appended, []);
  assert.equal(context.timelineMutation, false);
});

test('an uncertain marker append leaves the live session unavailable until recovery', async () => {
  const user = { type: 'message', role: 'user', content: 'one', turnId: 'turn-1' };
  const records = [{ type: 'turn_accepted', payload: { turnId: 'turn-1' } },
    { type: 'message', payload: user }];
  const context = { sessionId: 'uncertain', liveTurn: null, engine: {
    active: null, transcript: [user], store: {
      async readRecords() { return { records }; },
      async append() { throw new Error('flush uncertain after write'); },
    },
  } };
  await assert.rejects(() => runDesktopSessionRevert(context, { messageID: 'uncertain:message:0' }),
    /flush uncertain after write/u);
  assert.equal(context.closing, true);
  assert.equal(context.timelineMutation, false);
  assert.deepEqual(context.engine.transcript, [user]);
  await assert.rejects(() => runDesktopSessionRevert(context, { messageID: 'uncertain:message:0' }),
    (error) => error.code === 'desktop_revert_busy');
});

test('unrevert replaces a large transcript without spreading it into call arguments', async () => {
  const user = { type: 'message', role: 'user', content: 'one', turnId: 'turn-1' };
  const records = Array.from({ length: 200_000 }, () => ({ type: 'message', payload: user }));
  records.push({ type: 'revert_point', payload: { reverted_turn_ids: ['turn-1'] } });
  const context = { sessionId: 'large', liveTurn: null, engine: {
    active: null, transcript: [], store: {
      async readRecords() { return { records }; },
      async append() {},
    },
  } };
  await runDesktopSessionUnrevert(context);
  assert.equal(context.engine.transcript.length, 200_000);
  assert.equal(context.engine.transcript[0], user);
  assert.equal(context.timelineMutation, false);
});

test('native revert hides the boundary turn onward, restarts clean, and unrevert restores it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-revert-'));
  const config = resolveManifest({ persistence: 'durable', workspace_root: root,
    providers: [{ id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback' }] });
  let step = 0;
  const providerFactory = () => ({ async *stream() {
    step += 1;
    yield { type: 'text', text: `Answer ${step}.` }; yield { type: 'terminal', finishReason: 'stop', usage: null };
  } });
  const options = { config, sessionId: 'rev1', storeRoot: join(root, 'sessions'), telemetryRoot: join(root, 'telemetry'),
    providerFactory, reviewerRoot: join(root, 'reviews'), governanceRoot: join(root, 'governance'), skillRoots: [], hookRoots: [] };
  const engine = new SessionEngine(options);
  await engine.initialize();
  let closed = false;
  const close = async (id) => { if (!closed) { closed = true; await engine.shutdown({ request_id: id, type: 'shutdown' }); } };
  try {
    await engine.submit({ request_id: 'r1', content: 'first' }, principal);
    await engine.submit({ request_id: 'r2', content: 'second' }, principal);
    const assistantCount = engine.transcript.filter((r) => r.type === 'message' && r.role === 'assistant').length;
    assert.equal(assistantCount, 2);
    // Revert to the first turn's user message: everything from that turn on is hidden.
    const boundaryIndex = engine.transcript.findIndex((r) => r.type === 'message' && r.role === 'user');
    const result = await runDesktopSessionRevert({ sessionId: 'rev1', engine, liveTurn: null }, {
      messageID: `rev1:message:${boundaryIndex}` });
    assert.deepEqual(result.reverted_turn_ids.length, 2);
    assert.equal(engine.transcript.filter((r) => r.type === 'message').length, 0);
    assert.equal(engine.latestTurnOutcome, null);
    // A new turn after the revert works and keeps only itself.
    await engine.submit({ request_id: 'r3', content: 'after revert' }, principal);
    assert.equal(engine.latestTurnOutcome.request_id, 'r3');
    assert.deepEqual(engine.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['after revert']);
    // The journal kept everything; unrevert replays the hidden turns back.
    await runDesktopSessionUnrevert({ sessionId: 'rev1', engine, liveTurn: null });
    assert.equal(engine.latestTurnOutcome.request_id, 'r3');
    assert.deepEqual(engine.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['first', 'second', 'after revert']);
    // A consumed revert point cannot be unreverted again.
    await assert.rejects(() => runDesktopSessionUnrevert({ sessionId: 'rev1', engine, liveTurn: null }),
      (error) => error.code === 'desktop_revert_none');
    // Restart: replay honors the final state (revert point then cleared marker).
    await close('shutdown');
    const resumed = new SessionEngine(options);
    await resumed.initialize();
    try {
      assert.equal(resumed.latestTurnOutcome.request_id, 'r3');
      assert.equal(resumed.transcript.some((r) => r.type === 'turn_outcome'), false);
      assert.deepEqual(resumed.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
        ['first', 'second', 'after revert']);
      const journal = await recoverJournal(resumed.store.path);
      assert.equal(journal.records.filter((r) => r.type === 'revert_point').length, 1);
      assert.equal(journal.records.filter((r) => r.type === 'revert_cleared').length, 1);
    } finally { await resumed.shutdown({ request_id: 'shutdown-2', type: 'shutdown' }); }
  } finally { await close('shutdown-final'); }
});

test('stacked revert cycles unwrap innermost-first and each unrevert closes one cycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-revert3-'));
  const config = resolveManifest({ persistence: 'durable', workspace_root: root,
    providers: [{ id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback' }] });
  let step = 0;
  const providerFactory = () => ({ async *stream() {
    step += 1;
    yield { type: 'text', text: `Answer ${step}.` }; yield { type: 'terminal', finishReason: 'stop', usage: null };
  } });
  const options = { config, sessionId: 'rev3', storeRoot: join(root, 'sessions'), telemetryRoot: join(root, 'telemetry'),
    providerFactory, reviewerRoot: join(root, 'reviews'), governanceRoot: join(root, 'governance'), skillRoots: [], hookRoots: [] };
  const engine = new SessionEngine(options);
  await engine.initialize();
  const context = { sessionId: 'rev3', engine, liveTurn: null };
  let closed = false;
  try {
    await engine.submit({ request_id: 'r1', content: 'first' }, principal);
    await engine.submit({ request_id: 'r2', content: 'second' }, principal);
    const b1 = engine.transcript.findIndex((r) => r.type === 'message' && r.role === 'user');
    await runDesktopSessionRevert(context, { messageID: `rev3:message:${b1}` });
    await engine.submit({ request_id: 'r3', content: 'third' }, principal);
    const b2 = engine.transcript.findIndex((r) => r.type === 'message' && r.role === 'user');
    await runDesktopSessionRevert(context, { messageID: `rev3:message:${b2}` });
    assert.equal(engine.transcript.filter((r) => r.type === 'message').length, 0);
    // First unrevert closes the innermost cycle: 'third' returns, the outer cut stays.
    await runDesktopSessionUnrevert(context);
    assert.deepEqual(engine.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['third']);
    // Second unrevert closes the outer cycle: everything returns.
    await runDesktopSessionUnrevert(context);
    assert.deepEqual(engine.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['first', 'second', 'third']);
    // Both cycles consumed: further unrevert is a 409.
    await assert.rejects(() => runDesktopSessionUnrevert(context), (error) => error.code === 'desktop_revert_none');
    await engine.shutdown({ request_id: 'shutdown', type: 'shutdown' });
    closed = true;
    const resumed = new SessionEngine(options);
    await resumed.initialize();
    try {
      assert.deepEqual(resumed.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
        ['first', 'second', 'third']);
    } finally { await resumed.shutdown({ request_id: 'shutdown-2', type: 'shutdown' }); }
  } finally { if (!closed) await engine.shutdown({ request_id: 'shutdown-3', type: 'shutdown' }).catch(() => undefined); }
});

test('a fork from a session with an active revert does not inherit revert markers', async () => {
  const { forkPrefixRecords } = await import('../src/persistence/fork-records.js');
  const root = await mkdtemp(join(tmpdir(), 'nna-revert4-'));
  const config = resolveManifest({ persistence: 'durable', workspace_root: root,
    providers: [{ id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback' }] });
  let step = 0;
  const providerFactory = () => ({ async *stream() {
    step += 1;
    yield { type: 'text', text: `Answer ${step}.` }; yield { type: 'terminal', finishReason: 'stop', usage: null };
  } });
  const options = { config, sessionId: 'rev4', storeRoot: join(root, 'sessions'), telemetryRoot: join(root, 'telemetry'),
    providerFactory, reviewerRoot: join(root, 'reviews'), governanceRoot: join(root, 'governance'), skillRoots: [], hookRoots: [] };
  const engine = new SessionEngine(options);
  await engine.initialize();
  try {
    await engine.submit({ request_id: 'r1', content: 'first' }, principal);
    await engine.submit({ request_id: 'r2', content: 'second' }, principal);
    const b1 = engine.transcript.findIndex((r) => r.type === 'message' && r.role === 'user');
    await runDesktopSessionRevert({ sessionId: 'rev4', engine, liveTurn: null }, { messageID: `rev4:message:${b1}` });
    const { records } = await engine.store.readRecords();
    // Fork at the FIRST turn's outcome — the prefix spans the revert marker region.
    const firstTurnId = records.find((r) => r.type === 'message')?.payload.turnId;
    const prefix = forkPrefixRecords(records, firstTurnId);
    assert.equal(prefix.filter((r) => r.type === 'revert_point' || r.type === 'revert_cleared').length, 0);
    assert.ok(prefix.some((r) => r.type === 'message'), 'prefix still carries transcript records');
  } finally { await engine.shutdown({ request_id: 'shutdown', type: 'shutdown' }).catch(() => undefined); }
});

test('a persisted revert point survives restart before unrevert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-revert2-'));
  const config = resolveManifest({ persistence: 'durable', workspace_root: root,
    providers: [{ id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback' }] });
  let step = 0;
  const providerFactory = () => ({ async *stream() {
    step += 1;
    yield { type: 'text', text: `Answer ${step}.` }; yield { type: 'terminal', finishReason: 'stop', usage: null };
  } });
  const options = { config, sessionId: 'rev2', storeRoot: join(root, 'sessions'), telemetryRoot: join(root, 'telemetry'),
    providerFactory, reviewerRoot: join(root, 'reviews'), governanceRoot: join(root, 'governance'), skillRoots: [], hookRoots: [] };
  const engine = new SessionEngine(options);
  await engine.initialize();
  await engine.submit({ request_id: 'r1', content: 'one' }, principal);
  await engine.submit({ request_id: 'r2', content: 'two' }, principal);
  const fact = { type: 'compaction', summary: 'reverted secret from two' };
  await engine.store.append('compaction_snapshot', { records: engine.transcript, fact });
  engine.transcript.push(fact);
  const boundaryIndex = engine.transcript.findIndex((r) => r.type === 'message' && r.role === 'user');
  await runDesktopSessionRevert({ sessionId: 'rev2', engine, liveTurn: null }, { messageID: `rev2:message:${boundaryIndex}` });
  assert.equal(engine.transcript.some((item) => item.type === 'compaction'), false);
  await engine.shutdown({ request_id: 'shutdown', type: 'shutdown' });
  const resumed = new SessionEngine(options);
  await resumed.initialize();
  let closed = false;
  try {
    assert.equal(resumed.transcript.filter((r) => r.type === 'message').length, 0);
    assert.equal(resumed.transcript.some((item) => item.type === 'compaction'), false);
    // unrevert after restart restores both turns.
    await runDesktopSessionUnrevert({ sessionId: 'rev2', engine: resumed, liveTurn: null });
    assert.deepEqual(resumed.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['one', 'two']);
    await resumed.shutdown({ request_id: 'shutdown-2', type: 'shutdown' });
    const again = new SessionEngine(options);
    await again.initialize();
    try {
      assert.deepEqual(again.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
        ['one', 'two']);
    } finally { await again.shutdown({ request_id: 'shutdown-3', type: 'shutdown' }); }
  } finally { if (!closed) { closed = true; await resumed.shutdown({ request_id: 'shutdown-4', type: 'shutdown' }).catch(() => undefined); } }
});
