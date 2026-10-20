// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { ExperienceEngine as InteractiveWorkspace } from '../src/experience-engine.js';
import { submitEditor } from '../src/tui.js';
import { CanonicalIngress } from '../src/ingress.js';
import { JournalStore } from '../src/store.js';
import { cancelWorkspaceSession, submitWorkspaceSession } from '../src/experience/session-broker.js';
import {
  detachConsoleAttachment, queueClipboardImage, queueConsoleAttachment, queuePastedImagePaths,
} from '../src/experience/attachments.js';

function configuration(root, persistence = 'ephemeral') {
  return resolveManifest({
    persistence, workspace_root: root,
    provider: {
      id: 'vision-local', endpoint: 'http://127.0.0.1:9/v1', model: 'vision-model', trust_zone: 'loopback',
      capabilities: { images: true, tools: true },
    },
    attachments: { enabled: true, max_bytes: 1024, retain: false },
  });
}

test('Console queues tab-local images and submits them through managed admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-attachment-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  const providerFactory = () => ({ async *stream(request) {
    if (Array.isArray(request.messages[0]?.content)) yield { type: 'text', text: 'A small test image.' };
    else yield { type: 'text', text: 'I used the admitted image observation.' };
    yield { type: 'terminal' };
  } });
  const workspace = new InteractiveWorkspace({ config: configuration(root), providerFactory, attachmentRoot: join(root, 'attachments') });
  await workspace.create('Main', 'main');
  const queued = await queueConsoleAttachment(workspace, 'sample.png');
  assert.equal(queued.mime_type, 'image/png');
  assert.equal(workspace.projection.active().pendingAttachments.length, 1);
  await workspace.submitActive('Describe the attached image.');
  assert.equal(workspace.projection.active().pendingAttachments.length, 0);
  assert.ok(workspace.projection.active().records.some((item) => item.type === 'attachment_status' && item.state === 'admitted'),
    JSON.stringify(workspace.projection.active().records));
  await workspace.shutdown();
});

test('rejected Console submission preserves its draft, attachments, and honest transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-rejected-'));
  const workspace = new InteractiveWorkspace({ config: configuration(root) });
  await workspace.create('Main', 'main');
  try {
    const session = workspace.sessions.get('main');
    const projected = workspace.projection.active();
    projected.editor.set('Keep this draft');
    projected.pendingAttachments.push({ path: 'queued.png', mime_type: 'image/png' });
    session.ingress.start = () => ({ operation: Promise.resolve({ accepted: false, reason: 'busy' }) });
    await submitEditor(workspace, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(projected.editor.text, 'Keep this draft');
    assert.equal(projected.pendingAttachments.length, 1);
    assert.equal(session.meaningful, false);
    assert.equal(projected.records.some((item) => item.type === 'user_input'), false);
    session.ingress.start = () => { throw Object.assign(new Error('bad envelope'), { code: 'invalid_command' }); };
    await assert.rejects(submitEditor(workspace, () => undefined), { code: 'invalid_command' });
    assert.equal(session.pendingSubmission, null);
    assert.equal(projected.editor.text, 'Keep this draft');
    assert.equal(projected.pendingAttachments.length, 1);
  } finally { await workspace.shutdown(); }
});

test('Console consumes only the accepted draft and attachments after matching ingress acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-accepted-'));
  const workspace = new InteractiveWorkspace({ config: configuration(root) });
  await workspace.create('Main', 'main');
  try {
    const session = workspace.sessions.get('main');
    const projected = workspace.projection.active();
    projected.editor.set('First request');
    const firstAttachment = { path: 'first.png', mime_type: 'image/png' };
    projected.pendingAttachments.push(firstAttachment);
    let requestId;
    let finish;
    session.ingress.start = (command) => {
      requestId = command.request_id;
      return { operation: new Promise((resolve) => { finish = resolve; }) };
    };
    await submitEditor(workspace, () => undefined);
    assert.equal(projected.editor.text, 'First request');
    assert.equal(projected.pendingAttachments.length, 1);
    assert.equal(projected.records.some((item) => item.type === 'user_input'), false);

    projected.editor.insert(' edited while waiting');
    projected.pendingAttachments.push({ path: 'later.png', mime_type: 'image/png' });
    await session.engine.output({ type: 'accepted', accepted: true, request_id: requestId, turn_id: 'turn-1' });
    assert.equal(projected.editor.text, 'First request edited while waiting');
    assert.deepEqual(projected.pendingAttachments.map((item) => item.path), ['later.png']);
    assert.equal(projected.records.filter((item) => item.type === 'user_input').length, 1);
    assert.equal(session.meaningful, true);
    finish({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    await session.engine.output({ type: 'turn_result', turn_id: 'turn-1', outcome: 'completed' });

    projected.editor.set('Second request');
    await submitEditor(workspace, () => undefined);
    assert.equal(projected.editor.text, 'Second request');
    await session.engine.output({ type: 'accepted', accepted: true, request_id: requestId, turn_id: 'turn-2' });
    assert.equal(projected.editor.text, '');
    assert.equal(projected.pendingAttachments.length, 0);
    assert.deepEqual(projected.records.filter((item) => item.type === 'user_input').map((item) => item.text),
      ['First request', 'Second request']);
    finish({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    await session.engine.output({ type: 'turn_result', turn_id: 'turn-2', outcome: 'completed' });
  } finally { await workspace.shutdown(); }
});

test('a repeated Enter while submission admission is pending keeps the live turn and draft intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-pending-'));
  const workspace = new InteractiveWorkspace({ config: configuration(root) });
  await workspace.create('Main', 'main');
  try {
    const session = workspace.sessions.get('main');
    const projected = workspace.projection.active();
    projected.editor.set('Submit once');
    let requestId;
    let finish;
    let submissions = 0;
    session.ingress.start = (command) => {
      submissions += 1;
      requestId = command.request_id;
      return { operation: new Promise((resolve) => { finish = resolve; }) };
    };
    await submitEditor(workspace, () => undefined);
    await submitEditor(workspace, () => undefined);
    assert.equal(submissions, 1);
    assert.equal(projected.editor.text, 'Submit once');
    assert.equal(projected.state, 'idle');
    assert.equal(projected.records.filter((item) => item.type === 'user_input').length, 0);
    await session.engine.output({ type: 'accepted', accepted: true, request_id: requestId, turn_id: 'turn-1' });
    assert.equal(projected.editor.text, '');
    finish({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
  } finally { await workspace.shutdown(); }
});

test('attached session messages appear only after matching engine acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attached-accepted-'));
  const workspace = new InteractiveWorkspace({ config: configuration(root) });
  await workspace.create('Main', 'main');
  try {
    const session = workspace.sessions.get('main');
    const projected = workspace.projection.active();
    session.ingress.start = () => ({ operation: Promise.resolve({ accepted: false, reason: 'busy' }) });
    assert.deepEqual(await workspace.submitSession('main', 'busy message'), { accepted: false, reason: 'busy' });
    assert.equal(projected.records.some((item) => item.type === 'user_input'), false);
    assert.equal(session.meaningful, false);

    let requestId;
    let finish;
    session.ingress.start = (command) => {
      requestId = command.request_id;
      return { operation: new Promise((resolve) => { finish = resolve; }) };
    };
    const operation = workspace.submitSession('main', 'accepted message');
    assert.equal(projected.records.some((item) => item.type === 'user_input'), false);
    await session.engine.output({ type: 'accepted', accepted: true, request_id: requestId, turn_id: 'turn-2' });
    assert.deepEqual(projected.records.filter((item) => item.type === 'user_input').map((item) => item.text), ['accepted message']);
    finish({ accepted: true });
    await operation;
  } finally { await workspace.shutdown(); }
});

test('attached duplicate request IDs return ingress receipts without a second projected message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attached-duplicate-'));
  const workspace = new InteractiveWorkspace({ config: configuration(root) });
  await workspace.create('Main', 'main');
  try {
    const session = workspace.sessions.get('main');
    const projected = workspace.projection.active();
    let accept;
    const gate = new Promise((resolve) => { accept = resolve; });
    let executions = 0;
    session.ingress = new CanonicalIngress({ async submit(command) {
      executions += 1;
      await gate;
      await session.engine.output({ type: 'accepted', accepted: true,
        request_id: command.request_id, turn_id: 'turn-attached' });
      return { accepted: true };
    } }, { interactive: true });
    const first = workspace.submitSession('main', 'attached request', 'gateway-request-1');
    assert.deepEqual(await workspace.submitSession('main', 'attached request', 'gateway-request-1'),
      { accepted: false, duplicate: true, pending: true });
    assert.equal(projected.records.filter((item) => item.type === 'user_input').length, 0);
    accept();
    assert.deepEqual(await first, { accepted: true });
    assert.deepEqual(await workspace.submitSession('main', 'attached request', 'gateway-request-1'),
      { accepted: false, duplicate: true, pending: false });
    assert.equal(executions, 1);
    assert.deepEqual(projected.records.filter((item) => item.type === 'user_input').map((item) => item.text),
      ['attached request']);
  } finally { await workspace.shutdown(); }
});

test('attached request ID is deduplicated from the durable turn journal after Console restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attached-restart-'));
  const options = {
    config: configuration(root, 'durable'), storeRoot: join(root, 'sessions'),
    reviewerRoot: join(root, 'reviewer'),
    providerFactory: () => ({ async *stream() {
      yield { type: 'text', text: 'Completed once.' };
      yield { type: 'terminal' };
    } }),
  };
  const first = new InteractiveWorkspace(options);
  await first.create('Main', 'main');
  await first.submitSession('main', 'A durable request', 'telegram-update-123');
  await first.shutdown();

  const restarted = new InteractiveWorkspace(options);
  await restarted.create('Main', 'main');
  try {
    const projected = restarted.projection.active();
    const before = projected.records.filter((item) => item.type === 'user_input').length;
    const duplicate = await restarted.submitSession('main', 'A durable request', 'telegram-update-123');
    assert.deepEqual(duplicate, { accepted: false, duplicate: true, pending: false });
    assert.equal(projected.records.filter((item) => item.type === 'user_input').length, before);
    assert.equal(restarted.activeEngine().state.state, 'idle');
  } finally { await restarted.shutdown(); }
});

test('attached cancel durably fences a delayed broker submit across owner restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attached-cancel-fence-'));
  const firstStore = new JournalStore(root, 'main'); await firstStore.open();
  const makeWorkspace = (store) => {
    const session = { id: 'main', engine: { store, transcript: [], state: { state: 'idle' }, active: null },
      ingress: { start: () => assert.fail('fenced submission must not reach ingress'),
        submit: () => assert.fail('no active turn to cancel') } };
    return { sessions: new Map([['main', session]]),
      projection: { sessions: new Map([['main', { pendingAttachments: [] }]]), apply() {} } };
  };
  const first = makeWorkspace(firstStore);
  assert.deepEqual(await cancelWorkspaceSession(first, 'main', undefined, ['gateway_update_7']),
    { accepted: true, already_terminal: true });
  assert.deepEqual(await submitWorkspaceSession(first, 'main', 'delayed HTTP request', 'gateway_update_7'),
    { accepted: false, cancelled: true });
  await firstStore.close();
  const recoveredStore = new JournalStore(root, 'main'); await recoveredStore.open();
  try {
    const recovered = makeWorkspace(recoveredStore);
    assert.deepEqual(await submitWorkspaceSession(recovered, 'main', 'delayed HTTP request', 'gateway_update_7'),
      { accepted: false, cancelled: true });
  } finally { await recoveredStore.close(); }
});

test('attached cancel prioritizes a fenced request admitted after an older descriptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attached-cancel-admitted-'));
  const store = new JournalStore(root, 'main'); await store.open();
  let finish, aborted = false;
  const operation = new Promise((resolve) => { finish = resolve; });
  const session = { id: 'main', engine: { store, transcript: [], state: { state: 'idle' }, active: null },
    ingress: { start(command) {
      session.engine.active = { turnId: 'turn-A', requestId: command.request_id,
        controller: { abort() { aborted = true; finish({ outcome: 'cancelled' }); } } };
      return { duplicate: false, operation };
    }, async submit(command) {
      assert.equal(command.expected_turn_id, 'turn-A');
      session.engine.active.controller.abort();
      return { accepted: true };
    } } };
  const workspace = { sessions: new Map([['main', session]]),
    projection: { sessions: new Map([['main', { pendingAttachments: [] }]]), apply() {} },
    _maybeAutoName: async () => undefined };
  try {
    const submitted = submitWorkspaceSession(workspace, 'main', 'work', 'gateway_update_8');
    const cancelled = await cancelWorkspaceSession(workspace, 'main', 'turn-older', ['gateway_update_8']);
    assert.deepEqual(cancelled, { accepted: true });
    assert.equal(aborted, true);
    assert.deepEqual(await submitted, { outcome: 'cancelled' });
  } finally { finish({ outcome: 'cancelled' }); await store.close(); }
});

test('queued attachment removal is indexed, bounded, and conversation-local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-detach-'));
  const image = join(root, 'sample.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  await queueConsoleAttachment(workspace, image);
  assert.equal(detachConsoleAttachment(workspace, '1'), 1);
  assert.throws(() => detachConsoleAttachment(workspace, '1'), { code: 'attachment_selection_invalid' });
  await workspace.shutdown();
});

test('clipboard images persist under the session attachment store and dropped image paths queue directly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-ingress-'));
  const dropped = join(root, 'dropped image.png');
  await writeFile(dropped, Buffer.from('89504e470d0a1a0a', 'hex'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), attachmentRoot: join(root, 'attachments', 'main'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
    clipboardImageRead: async (path) => writeFile(path, Buffer.from('89504e470d0a1a0a', 'hex')),
  });
  await workspace.create('Main', 'main');
  const clipboard = await queueClipboardImage(workspace);
  assert.match(clipboard.path, /attachments[\\/]main[\\/]clipboard-ingress[\\/]clipboard-/u);
  assert.equal((await queuePastedImagePaths(workspace, `"${dropped}" "${dropped}"`)).length, 2);
  assert.equal(workspace.projection.active().pendingAttachments.length, 3);
  await workspace.shutdown();
});
