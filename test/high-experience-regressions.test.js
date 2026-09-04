// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorBuffer } from '../src/experience/projection.js';
import { maybeAutoNameConversation, renameWorkspaceConversation } from '../src/experience/conversation-title.js';
import { presentationState, restorePresentation } from '../src/experience/presentation.js';
import { WorkspaceTabPersistence } from '../src/experience/tab-persistence.js';
import { accumulateTokenAccounting } from '../src/experience/token-accounting.js';
import { isTerminalToolStatus, latestToolStatusIndexes } from '../src/experience/tool-lifecycle.js';
import { transcriptEvents } from '../src/experience/transcript.js';
import { deployWebSearch } from '../src/experience/websearch.js';
import { ContractError } from '../src/ids.js';

test('auto-title persistence failure permits retry without overwriting operator rename', async () => {
  const session = { id: 's', name: 'Conversation 1', autoNamed: false, nameLocked: false,
    engine: { transcript: [{ type: 'message', role: 'user', content: 'Database migration' }] } };
  const projected = { name: session.name }; let saved = false;
  const workspace = { projection: { sessions: new Map([['s', projected]]) }, onChange() {},
    _savePoolRecoverable: async () => saved };
  assert.equal(await maybeAutoNameConversation(workspace, session), false);
  assert.equal(session.name, 'Conversation 1'); assert.equal(session.autoNamed, false);
  saved = true; assert.equal(await maybeAutoNameConversation(workspace, session), true);
  assert.equal(session.name, 'Database Migration');
  session.autoNamed = false;
  workspace._savePoolRecoverable = async () => {
    session.name = projected.name = 'Operator choice'; session.nameLocked = true;
    return false;
  };
  assert.equal(await maybeAutoNameConversation(workspace, session), false);
  assert.equal(session.name, 'Operator choice'); assert.equal(projected.name, 'Operator choice');
});

test('rename rejects nontext, blank, controls, and ambiguous names before mutation', () => {
  const session = { id: 's', name: 'Keep' }, projected = { name: 'Keep' };
  const workspace = { sessions: new Map([['s', session], ['other', { name: 'Other' }]]),
    _active: () => session, projection: { active: () => projected }, tabPersistence: { observe() {} },
    _savePoolForBroker() {}, _tasksForBroker() {}, onChange() {} };
  for (const name of [42, ['a'], '   ', 'a\nb', '\u001b[31ma', 'Other']) {
    assert.throws(() => renameWorkspaceConversation(workspace, name), { code: 'session_name_invalid' });
    assert.equal(session.name, 'Keep');
  }
  renameWorkspaceConversation(workspace, '  New Name  ');
  assert.equal(projected.name, 'New Name');
});

function view() {
  return { editor: new EditorBuffer(), pendingAttachments: [{ path: 'image.png', size: 3 }],
    expandedTurns: new Set(), detailedTurns: new Set(), reviewPosture: 'auto-review', viewportEnd: null };
}

test('presentation snapshots do not alias live attachments', () => {
  const session = view(); const saved = presentationState(session);
  session.pendingAttachments[0].size = 8; session.pendingAttachments.splice(0);
  assert.deepEqual(saved.pending_attachments, [{ path: 'image.png', size: 3 }]);
});

test('restored viewport normalizes legacy absence and rejects invalid values before edits', () => {
  for (const viewport of [undefined, null, 0, 12]) {
    const session = view(); const saved = { ...presentationState(session), viewport_end: viewport };
    restorePresentation(session, {}, saved);
    assert.equal(session.viewportEnd, viewport ?? null);
  }
  for (const viewport of [-1, NaN, '3', {}]) {
    const session = view(); session.editor.set('kept');
    assert.throws(() => restorePresentation(session, {}, { ...presentationState(session), draft: 'changed', viewport_end: viewport }),
      { code: 'presentation_state_invalid' });
    assert.equal(session.editor.text, 'kept');
  }
});

test('tab saves always reject asynchronously and recover reports snapshot failures', async () => {
  for (const stage of ['enabled', 'snapshot']) {
    const failure = new Error(stage), failures = [];
    const persistence = new WorkspaceTabPersistence({ enabled: () => true, snapshot: () => ({ tabs: [], activeId: null }),
      [stage]: () => { throw failure; }, onFailure: (error) => failures.push(error), writer: async () => {} });
    let promise; assert.doesNotThrow(() => { promise = persistence.save(); });
    await assert.rejects(promise, (error) => error === failure);
    assert.equal(await persistence.recover(), false);
    assert.deepEqual(failures, [failure]);
    const tasks = new Set(); persistence.observe(undefined, tasks);
    await Promise.all([...tasks]); assert.equal(tasks.size, 0);
    assert.equal(failures.length, 2);
  }
});

test('token display accumulation is finite and role maps tolerate null and reserved keys', () => {
  const schema = 'nna.token-accounting.v1';
  const combined = accumulateTokenAccounting({ attempts: '2', by_role: null }, {
    schema, attempts: 1, accounted_input_tokens: NaN, by_role: null,
  });
  assert.equal(combined.attempts, 1); assert.equal(combined.accounted_input_tokens, 0);
  const roles = JSON.parse('{"__proto__":{"attempts":2,"measured_total_tokens":4}}');
  const result = accumulateTokenAccounting(null, { schema, by_role: roles });
  assert.equal(Object.hasOwn(result.by_role, '__proto__'), true);
  assert.equal(result.by_role.__proto__.attempts, 2);
});

test('terminal tool projection accepts known terminals, not arbitrary future strings', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'unknown_effect', 'duplicate_ignored', 'escalation_pending']) {
    assert.equal(isTerminalToolStatus(status), true);
  }
  for (const status of ['review_pending', 'approved', 'running', '  ', 'typo']) assert.equal(isTerminalToolStatus(status), false);
});

test('tool row indexing rejects nonarrays explicitly', () => {
  for (const value of [null, undefined, new Set(), {}]) {
    assert.throws(() => latestToolStatusIndexes(value), { code: 'transcript_invalid' });
  }
});

test('sparse transcripts fail validation before consumption', () => {
  assert.throws(() => transcriptEvents(new Array(1)), { code: 'transcript_record_invalid' });
});

test('partial search deployment wraps frozen errors without destroying their cause', async () => {
  const failure = Object.freeze(new ContractError('web_search_configuration_failed', 'offline'));
  const deployment = Object.freeze({ endpoint: 'http://localhost:8080' });
  await assert.rejects(deployWebSearch({ path: 'unused.json', deployment: { deploy: async () => deployment },
    client: { test: async () => { throw failure; } } }), (error) => {
    assert.equal(error.code, failure.code); assert.equal(error.cause, failure);
    assert.equal(error.partialDeployment, deployment); return true;
  });
});
