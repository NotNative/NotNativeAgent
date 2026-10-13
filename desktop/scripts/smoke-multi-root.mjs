// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { json } from './smoke-http.mjs';

const encoded = value => encodeURIComponent(value);
const samePath = (left, right) => process.platform === 'win32'
  ? left.replaceAll('\\', '/').toLowerCase() === right.replaceAll('\\', '/').toLowerCase()
  : left === right;
const callFor = app => (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
  ...init, signal: AbortSignal.timeout(5_000),
}));

/** Exercise the real admission, selected engine, and local file boundary on
 * two disjoint fixture roots before any restart. The fake provider reply is
 * observed through the native session transcript, not inferred from POST. */
export async function probeSelectedWorkspace(app, primary, secondary, providerRequests) {
  const call = callFor(app);
  const primaryMarker = join(primary, 'F1_PRIMARY_SENTINEL.txt');
  const secondaryMarker = join(secondary, 'F1_SECONDARY_SENTINEL.txt');
  await writeFile(primaryMarker, 'primary-only');
  await writeFile(secondaryMarker, 'secondary-only');
  const row = await admitSecondary(call, primary, secondary);
  const created = await json(call, '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Selected root smoke', workspace_id: row.id, directory: secondary }),
  }, 201);
  assert.equal(created.projectID, row.id);
  assert.ok(samePath(created.directory, secondary));
  const promptId = `selected_${randomUUID().replaceAll('-', '')}`;
  const priorRequests = providerRequests().length;
  const submitted = await call(`/api/session/${created.id}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: promptId, parts: [{ type: 'text', text: 'Reply with the smoke marker from this selected workspace.' }] }),
  });
  assert.equal(submitted.status, 204);
  await waitForReply(call, created.id);
  assert.ok(providerRequests().length > priorRequests, 'selected-root prompt did not reach the isolated provider');
  await probeGovernedWrite(call, created.id, secondary, primary, providerRequests);
  await probeGovernedReads(call, created.id, primaryMarker, providerRequests);
  const write = await json(call, `/api/fs/write?directory=${encoded(secondary)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'F1_SELECTED_WRITE.txt', content: 'selected-write' }),
  }, 200);
  assert.equal(write.success, true);
  assert.equal(await readFile(join(secondary, 'F1_SELECTED_WRITE.txt'), 'utf8'), 'selected-write');
  await assert.rejects(access(join(primary, 'F1_SELECTED_WRITE.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(primaryMarker, 'utf8'), 'primary-only');
  assert.equal(await readFile(secondaryMarker, 'utf8'), 'secondary-only');
  const escape = await call(`/api/fs/read?directory=${encoded(secondary)}&path=${encoded(relative(secondary, primaryMarker))}`);
  assert.equal(escape.status, 403, 'selected root must not read its sibling fixture');
  await probeRemovedWorkspace(call, primary, row.id);
  return { id: created.id, workspaceId: row.id, secondary };
}

async function probeGovernedWrite(call, sessionId, secondary, primary, providerRequests) {
  const repliesBefore = await replyCount(call, sessionId);
  await submitToolPrompt(call, sessionId, 'NND_TOOL_WRITE_ALLOW: Write F1_GOVERNED_WRITE.txt with governed-selected in this workspace.');
  await waitForReply(call, sessionId, repliesBefore + 1);
  const toolResult = providerRequests().flatMap(request => request.messages ?? [])
    .find(message => message.role === 'tool' && message.tool_call_id === 'nnd_write_allow');
  assert.ok(toolResult, 'selected-root governed write did not reach NNA');
  assert.ok(String(toolResult.content).includes('"tool_lifecycle_status":"succeeded"'),
    `selected-root governed write failed: ${String(toolResult.content).slice(0, 500)}`);
  assert.equal(await readFile(join(secondary, 'F1_GOVERNED_WRITE.txt'), 'utf8'), 'governed-selected');
  await assert.rejects(access(join(primary, 'F1_GOVERNED_WRITE.txt')), { code: 'ENOENT' });
}

async function submitToolPrompt(call, sessionId, text) {
  const body = JSON.stringify({ messageID: `tool_${randomUUID().replaceAll('-', '')}`, parts: [{ type: 'text', text }] });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sent = await call(`/api/session/${sessionId}/prompt_async`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    if (sent.status === 204) return;
    assert.equal(sent.status, 409, `tool prompt failed: ${await sent.text()}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`native session stayed busy before governed tool prompt: ${text}`);
}

async function probeGovernedReads(call, sessionId, primaryMarker, providerRequests) {
  for (const [prompt, callId, expected, forbidden] of [
    ['NND_TOOL_READ_ALLOW', 'nnd_read_allow', 'secondary-only', 'primary-only'],
    [`NND_TOOL_READ_ESCAPE:${primaryMarker}`, 'nnd_read_escape', null, 'primary-only'],
  ]) {
    const repliesBefore = await replyCount(call, sessionId);
    await submitToolPrompt(call, sessionId, prompt);
    await waitForReply(call, sessionId, repliesBefore + 1);
    const toolResult = providerRequests().flatMap(request => request.messages ?? [])
      .find(message => message.role === 'tool' && message.tool_call_id === callId);
    assert.ok(toolResult, `${callId} did not execute through NNA`);
    assert.ok(!String(toolResult.content).includes(forbidden),
      `${callId} leaked another workspace: ${String(toolResult.content).slice(0, 500)}`);
    if (expected) assert.ok(String(toolResult.content).includes(expected), `${callId} did not read its selected workspace`);
    else assert.ok(String(toolResult.content).includes('tool_scope_denied'),
      `${callId} was not denied by the workspace boundary`);
  }
}

async function admitSecondary(call, primary, secondary) {
  assert.equal(basename(primary), basename(secondary), 'fixture must test conflicting same-name projects');
  const before = await json(call, '/api/v1/nnd/workspaces/admissions', 200);
  assert.equal(before.selection_enabled, true);
  assert.ok(samePath(before.attached.root, primary));
  const operationId = randomUUID();
  const receipt = await json(call, '/api/v1/nnd/workspaces/admissions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installation_id: before.installation_id, data_id: before.data_id,
      expected_revision: before.revision, operation_id: operationId, root: secondary }),
  }, 200);
  assert.equal(receipt.persistence, 'saved');
  assert.equal(receipt.operation_id, operationId);
  const discovered = await json(call, `/api/v1/nnd/workspaces/admissions/operations/${operationId}`, 200);
  assert.equal(discovered.persistence, 'saved');
  const inventory = await json(call, '/api/v1/nnd/workspaces/admissions', 200);
  const row = inventory.admitted.find(item => samePath(item.root, secondary));
  assert.match(row?.id ?? '', /^ws_[a-f0-9]{24}$/u);
  assert.notEqual(row.id, inventory.attached.id, 'same-name roots must have distinct workspace identities');
  assert.equal(row.operation_id, operationId);
  const projects = await json(call, '/api/project', 200);
  assert.ok(projects.some(item => item.id === row.id && samePath(item.worktree, secondary)));
  assert.ok(projects.some(item => item.id === inventory.attached.id && samePath(item.worktree, primary)));
  const status = await json(call, `/api/git/status?directory=${encoded(secondary)}`, 200);
  assert.equal(status.isGitRepository, true);
  if (process.platform === 'win32') {
    const aliased = await json(call, `/api/native-workspace/admission?directory=${encoded(secondary.toLowerCase())}`, 200);
    assert.equal(aliased.workspace_id, row.id, 'Windows case alias must retain the same workspace identity');
  }
  const junction = join(primary, 'F1_JUNCTION_ESCAPE');
  await symlink(secondary, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const junctionAttempt = await call('/api/v1/nnd/workspaces/admissions', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installation_id: inventory.installation_id, data_id: inventory.data_id,
      expected_revision: inventory.revision, operation_id: randomUUID(), root: junction }),
  });
  assert.notEqual(junctionAttempt.status, 200, 'junction must not become an admitted root');
  return row;
}

async function probeRemovedWorkspace(call, primary, selectedId) {
  const vanished = join(dirname(primary), 'vanished');
  await mkdir(vanished);
  const canonical = await realpath(vanished);
  const before = await json(call, '/api/v1/nnd/workspaces/admissions', 200);
  const admit = await json(call, '/api/v1/nnd/workspaces/admissions', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installation_id: before.installation_id, data_id: before.data_id,
      expected_revision: before.revision, operation_id: randomUUID(), root: canonical }),
  }, 200);
  assert.equal(admit.persistence, 'saved');
  await rm(vanished, { recursive: true });
  const unavailable = await json(call, '/api/v1/nnd/workspaces/admissions', 200);
  assert.ok(unavailable.unavailable.some(item => item.root === canonical));
  assert.ok(unavailable.admitted.some(item => item.id === selectedId), 'missing root must not hide healthy project');
  const cleared = await json(call, '/api/v1/nnd/workspaces/admissions/revoke', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installation_id: unavailable.installation_id, data_id: unavailable.data_id,
      expected_revision: unavailable.revision, operation_id: randomUUID(), root: canonical }),
  }, 200);
  assert.equal(cleared.persistence, 'saved');
  const after = await json(call, '/api/v1/nnd/workspaces/admissions', 200);
  assert.equal(after.unavailable.some(item => item.root === canonical), false);
}

/** A Git-created worktree is a third execution root and remains protected
 * while it has a native session. Removal revokes admission before Git delete. */
export async function probeWorktreeWorkspace(app, primary, providerRequests) {
  const call = callFor(app);
  const createdResponse = await call(`/api/git/worktrees?directory=${encoded(primary)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'new', branchName: `f1-smoke-${randomUUID().slice(0, 8)}` }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200, `worktree admission: ${JSON.stringify(created)}`);
  const root = created.worktree?.path;
  assert.equal(typeof root, 'string');
  assert.match(created.workspace_id ?? '', /^ws_[a-f0-9]{24}$/u);
  const session = await json(call, '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Worktree smoke', workspace_id: created.workspace_id, directory: root }),
  }, 201);
  assert.equal(session.projectID, created.workspace_id);
  const priorRequests = providerRequests().length;
  const turn = await call(`/api/session/${session.id}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: `worktree_${randomUUID().replaceAll('-', '')}`,
      parts: [{ type: 'text', text: 'Reply with the smoke marker from this worktree.' }] }),
  });
  assert.equal(turn.status, 204);
  await waitForReply(call, session.id);
  assert.ok(providerRequests().length > priorRequests);
  const remove = () => call(`/api/git/worktrees?directory=${encoded(primary)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: root }),
  });
  assert.equal((await remove()).status, 409, 'bound native session must protect worktree removal');
  assert.equal(await json(call, `/api/session/${session.id}`, { method: 'DELETE' }, 200), true);
  assert.equal((await remove()).status, 200);
  await assert.rejects(access(root), { code: 'ENOENT' });
  const inventory = await json(call, '/api/v1/nnd/workspaces/admissions', 200);
  assert.equal(inventory.admitted.some(row => row.id === created.workspace_id), false);
  const stale = await call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_id: created.workspace_id, directory: root }) });
  assert.notEqual(stale.status, 201, 'stale worktree identity must not create a session');
}

export async function probeRestoredSelectedWorkspace(app, selected, providerRequests) {
  const call = callFor(app);
  const inventory = await json(call, '/api/v1/nnd/workspaces/admissions', 200);
  assert.ok(inventory.admitted.some(row => row.id === selected.workspaceId && samePath(row.root, selected.secondary)),
    'restart lost the admitted selected workspace');
  const restored = await json(call, `/api/session/${selected.id}`, 200);
  assert.equal(restored.projectID, selected.workspaceId);
  assert.ok(samePath(restored.directory, selected.secondary));
  await waitForReply(call, selected.id);
  const priorRequests = providerRequests().length;
  const priorReplies = await replyCount(call, selected.id);
  const submitted = await call(`/api/session/${selected.id}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: `restored_${randomUUID().replaceAll('-', '')}`,
      parts: [{ type: 'text', text: 'Reply again after selected workspace restart.' }] }),
  });
  assert.equal(submitted.status, 204);
  await waitForReply(call, selected.id, priorReplies + 1);
  assert.ok(providerRequests().length > priorRequests, 'restored selected-root prompt did not reach the isolated provider');
  const read = await call(`/api/fs/read?directory=${encoded(selected.secondary)}&path=F1_SELECTED_WRITE.txt`);
  assert.equal(read.status, 200);
  assert.equal(await read.text(), 'selected-write');
  assert.equal(await json(call, `/api/session/${selected.id}`, { method: 'DELETE' }, 200), true);
}

async function replyCount(call, id) {
  const messages = await json(call, `/api/session/${id}/message`, 200);
  return messages.filter(message => message.info?.role === 'assistant'
    && message.parts?.some(part => part.type === 'text' && part.text?.includes('NND_SOURCE_REPLY'))).length;
}

async function waitForReply(call, id, expectedCount = 1) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await replyCount(call, id) >= expectedCount) return;
    if (Date.now() >= deadline) throw new Error('selected-root native turn did not complete');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
