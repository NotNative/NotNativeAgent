// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { forkPrefixRecords } from '../src/persistence/fork-records.js';
import { recoverJournal } from '../src/store.js';
import { TypedSessionEngine as SessionEngine } from './typed-provider-fixture.js';

const turn = (turnId, id, role, text) => ({ type: 'message', payload: { id, turnId, role, content: text } });

const parentRecords = [
  { type: 'session_created', payload: { sessionId: 'parent' } },
  { type: 'authority_intent', payload: { id: 'int_1', content: 'first' } },
  { type: 'turn_accepted', payload: { turnId: 't1' } },
  turn('t1', 'msg_u1', 'user', 'hello'),
  { type: 'tool_request', payload: { id: 'tr_1', turnId: 't1' } },
  { type: 'tool_result', payload: { id: 'trs_1', turnId: 't1' } },
  turn('t1', 'msg_a1', 'assistant', 'done'),
  { type: 'turn_outcome', payload: { turnId: 't1' } },
  { type: 'turn_accepted', payload: { turnId: 't2' } },
  turn('t2', 'msg_u2', 'user', 'more'),
  turn('t2', 'msg_a2', 'assistant', 'second'),
  { type: 'turn_outcome', payload: { turnId: 't2' } },
];

test('fork prefix cuts at the boundary turn outcome and excludes parent identity records', () => {
  const prefix = forkPrefixRecords(parentRecords, 't1');
  assert.deepEqual(prefix.map((r) => r.type), ['authority_intent', 'turn_accepted', 'message', 'tool_request',
    'tool_result', 'message', 'turn_outcome']);
  assert.equal(prefix.at(-1).payload.turnId, 't1');
});

test('fork at the last completed turn inherits the whole journal minus identity', () => {
  const prefix = forkPrefixRecords(parentRecords, 't2');
  assert.equal(prefix.at(-1).type, 'turn_outcome');
  assert.ok(prefix.every((r) => r.type !== 'session_created'));
});

test('unsettled turns are refused before any child is created', () => {
  const openTurn = [...parentRecords.slice(0, 10)]; // turn t2 accepted, no outcome
  assert.throws(() => forkPrefixRecords(openTurn, 't2'), { code: 'nnd_fork_boundary_unsettled' });
  assert.throws(() => forkPrefixRecords(parentRecords, 't_missing'), { code: 'nnd_fork_boundary_unsettled' });
  assert.throws(() => forkPrefixRecords('nope', 't1'), { code: 'nnd_fork_invalid' });
});

test('a forked child journal replays the parent prefix and survives restart as its own durable session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-fork-'));
  const config = resolveManifest({ persistence: 'durable', workspace_root: root,
    providers: [{ id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback' }] });
  let step = 0;
  const providerFactory = () => ({ async *stream() {
    step += 1;
    yield { type: 'text', text: `Answer ${step}.` }; yield { type: 'terminal', finishReason: 'stop', usage: null };
  } });
  const options = { config, sessionId: 'fork_parent', storeRoot: join(root, 'sessions'), telemetryRoot: join(root, 'telemetry'),
    providerFactory, reviewerRoot: join(root, 'reviews'), governanceRoot: join(root, 'governance'), skillRoots: [], hookRoots: [] };
  const principal = { subjectId: 'u_test', platformRole: 'operator', permissions: ['nnd.session.submit'], workspaceIds: [],
    groupIds: [], traceId: 'trace_fork', issuedAt: '2026-10-11T00:00:00Z', requestId: 'req_fork_probe' };
  const parent = new SessionEngine(options);
  await parent.initialize();
  try {
    await parent.submit({ request_id: 'req_1', content: 'hello' }, principal);
    const boundaryIndex = parent.transcript.findIndex((r) => r.type === 'message' && r.role === 'assistant');
    const boundaryId = `fork_parent:message:${boundaryIndex}`;
    const { records } = await parent.store.readRecords();
    const turnId = parent.transcript[boundaryIndex].turnId;
    const prefix = forkPrefixRecords(records, turnId);
    const child = new SessionEngine({ ...options, sessionId: 'fork_child',
      forkIngest: { records: prefix, sourceSessionId: 'fork_parent', boundaryMessageId: boundaryId } });
    await child.initialize();
    try {
      const inherited = child.transcript.filter((r) => ['message', 'tool_request', 'tool_result'].includes(r.type));
      assert.ok(inherited.some((r) => r.role === 'user' && r.content === 'hello'));
      assert.ok(inherited.some((r) => r.role === 'assistant' && r.content === 'Answer 1.'));
      await child.submit({ request_id: 'req_c1', content: 'continue after fork' }, principal);
      // The seed must be inside the child's own journal: after shutdown, a
      // restart replays the inherited prefix without the parent's involvement.
      const journalSnapshot = await recoverJournal(child.store.path);
      await child.shutdown({ request_id: 'child-shutdown', type: 'shutdown' });
      assert.equal(journalSnapshot.records[0].type, 'session_created');
      assert.deepEqual(journalSnapshot.records[0].payload.sessionId, 'fork_child');
      const marker = journalSnapshot.records.find((r) => r.type === 'forked_from');
      assert.deepEqual(marker.payload, { source_session_id: 'fork_parent', boundary_message_id: boundaryId, record_count: prefix.length });
      const resumed = new SessionEngine({ ...options, sessionId: 'fork_child' });
      await resumed.initialize();
      try {
        assert.ok(resumed.transcript.some((r) => r.type === 'message' && r.content === 'hello'));
        assert.ok(resumed.transcript.some((r) => r.type === 'message' && r.content === 'continue after fork'));
      } finally { await resumed.shutdown({ request_id: 'resume-shutdown', type: 'shutdown' }); }
    } finally { if (child.store) await child.shutdown({ request_id: 'child-shutdown', type: 'shutdown' }).catch(() => undefined); }
  } finally { await parent.shutdown({ request_id: 'shutdown', type: 'shutdown' }); }
});
