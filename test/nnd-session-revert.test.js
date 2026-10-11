// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { recoverJournal } from '../src/store.js';
import { runNndSessionRevert, runNndSessionUnrevert } from '../src/nnd-session-revert.js';
import { TypedSessionEngine as SessionEngine } from './typed-provider-fixture.js';

const principal = { subjectId: 'u_test', platformRole: 'operator', permissions: ['nnd.session.submit'], workspaceIds: [],
  groupIds: [], traceId: 'trace_revert', issuedAt: '2026-10-11T00:00:00Z', requestId: 'req_revert_probe' };

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
    const result = await runNndSessionRevert({ sessionId: 'rev1', engine, liveTurn: null }, {
      messageID: `rev1:message:${boundaryIndex}` });
    assert.deepEqual(result.reverted_turn_ids.length, 2);
    assert.equal(engine.transcript.filter((r) => r.type === 'message').length, 0);
    // A new turn after the revert works and keeps only itself.
    await engine.submit({ request_id: 'r3', content: 'after revert' }, principal);
    assert.deepEqual(engine.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['after revert']);
    // The journal kept everything; unrevert replays the hidden turns back.
    await runNndSessionUnrevert({ sessionId: 'rev1', engine, liveTurn: null });
    assert.deepEqual(engine.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['first', 'second', 'after revert']);
    // A consumed revert point cannot be unreverted again.
    await assert.rejects(() => runNndSessionUnrevert({ sessionId: 'rev1', engine, liveTurn: null }),
      (error) => error.code === 'nnd_revert_none');
    // Restart: replay honors the final state (revert point then cleared marker).
    await close('shutdown');
    const resumed = new SessionEngine(options);
    await resumed.initialize();
    try {
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
    await runNndSessionRevert(context, { messageID: `rev3:message:${b1}` });
    await engine.submit({ request_id: 'r3', content: 'third' }, principal);
    const b2 = engine.transcript.findIndex((r) => r.type === 'message' && r.role === 'user');
    await runNndSessionRevert(context, { messageID: `rev3:message:${b2}` });
    assert.equal(engine.transcript.filter((r) => r.type === 'message').length, 0);
    // First unrevert closes the innermost cycle: 'third' returns, the outer cut stays.
    await runNndSessionUnrevert(context);
    assert.deepEqual(engine.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['third']);
    // Second unrevert closes the outer cycle: everything returns.
    await runNndSessionUnrevert(context);
    assert.deepEqual(engine.transcript.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.content),
      ['first', 'second', 'third']);
    // Both cycles consumed: further unrevert is a 409.
    await assert.rejects(() => runNndSessionUnrevert(context), (error) => error.code === 'nnd_revert_none');
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
    await runNndSessionRevert({ sessionId: 'rev4', engine, liveTurn: null }, { messageID: `rev4:message:${b1}` });
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
  const boundaryIndex = engine.transcript.findIndex((r) => r.type === 'message' && r.role === 'user');
  await runNndSessionRevert({ sessionId: 'rev2', engine, liveTurn: null }, { messageID: `rev2:message:${boundaryIndex}` });
  await engine.shutdown({ request_id: 'shutdown', type: 'shutdown' });
  const resumed = new SessionEngine(options);
  await resumed.initialize();
  let closed = false;
  try {
    assert.equal(resumed.transcript.filter((r) => r.type === 'message').length, 0);
    // unrevert after restart restores both turns.
    await runNndSessionUnrevert({ sessionId: 'rev2', engine: resumed, liveTurn: null });
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
