// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { JournalStore } from '../src/store.js';

function configuration(root) {
  return resolveManifest({
    persistence: 'durable', workspace_root: root, context_limit_bytes: 65_536,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'model', trust_zone: 'loopback' },
  });
}

test('explicit compaction and confirmed clear survive durable session recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-context-controls-'));
  const stores = join(root, 'sessions');
  const requests = [];
  const options = {
    config: configuration(root), sessionId: 'context-session', storeRoot: stores,
    reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream(request) {
      requests.push(request.messages);
      yield { type: 'text', text: 'x'.repeat(9_000) }; yield { type: 'terminal' };
    } }),
  };
  const first = new SessionEngine(options);
  await first.initialize();
  for (let index = 0; index < 7; index += 1) {
    await first.submit({ request_id: `turn-${index}`, content: `Continue the bounded task ${index}.` }, 'operator');
  }
  assert.equal(requests.some((messages) => messages.some((item) => typeof item.content === 'string'
    && item.content.includes('Continue the bounded task 4.'))), true);
  const before = first.transcript.length;
  const compacted = await first.compactConversation();
  assert.ok(compacted.omitted > 0);
  assert.equal(compacted.fact.projection.protectedCompletedTurns, 5);
  assert.equal(first.transcript.length, before + 1);
  assert.equal(first.transcript.at(-1).continuation.schema, 'nna.continuation.v1');
  const retainedUsers = compacted.fact.retainedRecords.filter((item) => item.type === 'message' && item.role === 'user')
    .map((item) => item.content);
  for (let index = 2; index < 7; index += 1) {
    assert.ok(retainedUsers.includes(`Continue the bounded task ${index}.`));
  }
  await first.shutdown({ request_id: 'shutdown-1', type: 'shutdown' });

  const second = new SessionEngine(options);
  await second.initialize();
  assert.equal(second.transcript.length, first.transcript.length);
  await second.submit({ request_id: 'continued-after-restart', content: 'Continue from that checkpoint.' }, 'operator');
  const resumed = requests.at(-1).filter((item) => item.role === 'user').map((item) => item.content).join('\n');
  assert.match(resumed, /Continue the bounded task 4\./u);
  assert.match(resumed, /Continue from that checkpoint\./u);
  const cleared = await second.clearConversation();
  assert.ok(cleared.removed > 0);
  await second.shutdown({ request_id: 'shutdown-2', type: 'shutdown' });

  const third = new SessionEngine(options);
  await third.initialize();
  assert.deepEqual(third.transcript, []);
  await third.shutdown({ request_id: 'shutdown-3', type: 'shutdown' });
});

test('restart applies a committed clear marker if the process stopped before clearing work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-clear-crash-'));
  const storeRoot = join(root, 'sessions');
  const options = {
    config: configuration(root), sessionId: 'clear-crash', storeRoot,
    reviewerRoot: join(root, 'reviewers'),
  };
  const first = new SessionEngine(options);
  await first.initialize();
  await first.setGoal('Old work must not return');
  await first.shutdown({ request_id: 'stop-before-clear' });

  const journal = new JournalStore(storeRoot, 'clear-crash');
  await journal.open();
  await journal.append('conversation_cleared', { workRevision: 2 });
  await journal.close();

  const resumed = new SessionEngine(options);
  await resumed.initialize();
  assert.equal(resumed.workStatus().goal, null);
  assert.equal(resumed.workStatus().revision, 2);
  assert.deepEqual(resumed.transcript, []);
  assert.deepEqual(resumed.authority.snapshot(resumed.config).intent, []);
  await resumed.shutdown({ request_id: 'stop-after-replay' });
});

test('clear revision survives when its marker ages beyond the bounded transcript tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-clear-old-marker-'));
  const storeRoot = join(root, 'sessions');
  const options = {
    config: configuration(root), sessionId: 'clear-old-marker', storeRoot,
    reviewerRoot: join(root, 'reviewers'),
    storeFactory: (path, id, storeOptions) => new JournalStore(path, id, {
      ...storeOptions, resumeRecordLimit: 8,
    }),
  };
  const first = new SessionEngine(options);
  await first.initialize();
  await first.setGoal('Old work');
  await first.clearConversation();
  await first.shutdown({ request_id: 'stop-before-tail-advances' });
  const journal = new JournalStore(storeRoot, 'clear-old-marker');
  await journal.open();
  for (let index = 0; index < 16; index += 1) {
    await journal.append('message', { type: 'message', role: 'assistant', content: `later ${index}` });
  }
  await journal.close();

  const resumed = new SessionEngine(options);
  await resumed.initialize();
  assert.equal(resumed.workStatus().revision, 2);
  assert.equal(resumed.workStatus().goal, null);
  await resumed.setGoal('New work');
  assert.equal(resumed.workStatus().revision, 3);
  await resumed.shutdown({ request_id: 'stop-after-old-marker-replay' });
});

test('incomplete control scan cannot silently reset work whose boundary is outside the tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-clear-unverified-marker-'));
  const storeRoot = join(root, 'sessions');
  const seed = new SessionEngine({
    config: configuration(root), sessionId: 'clear-unverified-marker', storeRoot,
    reviewerRoot: join(root, 'reviewers'),
  });
  await seed.initialize();
  await seed.setGoal('Old work');
  await seed.shutdown({ request_id: 'stop-before-tail-advances' });
  const journal = new JournalStore(storeRoot, 'clear-unverified-marker');
  await journal.open();
  for (let index = 0; index < 16; index += 1) {
    await journal.append('message', { type: 'message', role: 'assistant', content: `later ${index}` });
  }
  await journal.close();
  const resumed = new SessionEngine({
    config: configuration(root), sessionId: 'clear-unverified-marker', storeRoot,
    reviewerRoot: join(root, 'reviewers'),
    storeFactory: (path, id, storeOptions) => new JournalStore(path, id, {
      ...storeOptions, resumeRecordLimit: 8, controlScanMaxBytes: 64,
    }),
  });
  await assert.rejects(resumed.initialize(), { code: 'work_state_invalid' });
});

test('work status delivery failure after a committed clear cannot retain live conversation context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-clear-output-failure-'));
  const options = {
    config: configuration(root), sessionId: 'clear-output-failure', storeRoot: join(root, 'sessions'),
    reviewerRoot: join(root, 'reviewers'),
    output: async (record) => {
      if (record.type === 'work_status' && record.action === 'work_cleared') throw new Error('output unavailable');
    },
  };
  const first = new SessionEngine(options);
  await first.initialize();
  await first.setGoal('Old goal');
  first.transcript.push({ type: 'message', role: 'user', content: 'Old context' });
  first.authority.addAuthenticatedIntent('Old authority', 'operator');
  await assert.rejects(first.clearConversation(), /output unavailable/u);
  assert.deepEqual(first.transcript, []);
  assert.equal(first.workStatus().goal, null);
  assert.deepEqual(first.authority.snapshot(first.config).intent, []);
  await first.shutdown({ request_id: 'stop-after-output-failure' });

  const resumed = new SessionEngine(options);
  await resumed.initialize();
  assert.equal(resumed.workStatus().goal, null);
  assert.deepEqual(resumed.transcript, []);
  await resumed.shutdown({ request_id: 'stop-after-output-replay' });
});

test('terse handoff survives recovery while excluding prior transcript from future provider context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-handoff-control-'));
  const requests = [];
  const options = {
    config: configuration(root), sessionId: 'handoff-session', storeRoot: join(root, 'sessions'),
    reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream(request) {
      requests.push(request.messages);
      yield { type: 'text', text: 'completed' }; yield { type: 'terminal' };
    } }),
  };
  const first = new SessionEngine(options);
  await first.initialize();
  await first.submit({ request_id: 'old-turn', content: 'Old detail that must leave active context.' }, 'operator');
  const handoff = await first.handoffConversation();
  assert.equal(handoff.retained, 0);
  assert.equal(handoff.fact.continuation.schema, 'nna.handoff.v1');
  await first.shutdown({ request_id: 'shutdown-1', type: 'shutdown' });

  const second = new SessionEngine(options);
  await second.initialize();
  await second.submit({ request_id: 'new-turn', content: 'Continue from the handoff.' }, 'operator');
  const resumed = requests.at(-1).map((item) => item.content).filter((item) => typeof item === 'string').join('\n');
  assert.match(resumed, /NNA self-handoff/u);
  assert.match(resumed, /Continue from the handoff/u);
  await second.shutdown({ request_id: 'shutdown-2', type: 'shutdown' });
});
