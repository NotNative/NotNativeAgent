// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWireSession, buildPromptCommand, snapshotValue } from '../src/opencode/wire-session.js';

function recordingBus() {
  const frames = [];
  return {
    frames,
    publishSession(frame) { frames.push({ ...frame }); },
    publishGlobal(type, properties) { frames.push({ directory: null, project: null, sessionID: null, type, properties }); },
  };
}

function makeRecord(submit) {
  return { ocId: 'ses_t' , directory: 'C:\\fx', projectID: 'p'.repeat(40), ingress: { submit } };
}

function freshWireSession(record, bus) {
  return createWireSession({
    record, bus, version: '9',
    info: () => ({ id: record.ocId, directory: record.directory, tokens: {}, version: '9', time: { created: 1, updated: 2 } }),
  });
}

test('prompt admits, runs, settles, and closes in the observed gold cadence', async () => {
  let active;
  const bus = recordingBus();
  const record = makeRecord(async (command) => {
    active.observe({ type: 'stream_delta', text: 'HE' });
    active.observe({ type: 'stream_delta', text: 'LLO!' });
    return { outcome: 'completed', text: 'HELLO!', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, turn: 'turn-1' };
  });
  const wireSession = freshWireSession(record, bus);
  active = wireSession;
  const response = await wireSession.prompt([{ type: 'text', text: 'say hi' }]);
  assert.equal(response.info.role, 'assistant');
  assert.equal(response.info.finish, 'stop');
  assert.deepEqual(response.info.tokens, { total: 7, input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.deepEqual(response.parts.map((part) => part.type), ['step-start', 'text', 'step-finish']);
  const bareTypes = bus.frames.filter((frame) => !frame.mirror).map((frame) => frame.type);
  const mirroredTypes = bus.frames.filter((frame) => frame.mirror).map((frame) => frame.type);
  assert.deepEqual(mirroredTypes.slice(0, 4), ['session.updated', 'message.updated', 'message.part.updated', 'session.updated']);
  assert.deepEqual(bareTypes, [
    'session.status', 'session.diff', 'message.part.delta', 'message.part.delta',
    'session.status', 'session.idle',
  ]);
  assert.deepEqual(mirroredTypes.slice(4), [
    'message.updated', 'session.updated', 'message.part.updated', 'message.part.updated',
    'message.part.updated', 'message.part.updated', 'message.updated', 'session.updated', 'message.updated',
  ]);
  const deltas = bus.frames.filter((frame) => frame.type === 'message.part.delta');
  assert.deepEqual(deltas.map((frame) => frame.properties.delta), ['HE', 'LLO!']);
  assert.equal(deltas[0].properties.messageID, response.info.id);
  const messages = wireSession.messages();
  // Invariant: a closed turn is followed by the idle marker a client walks back
  // to, so three records describe one turn.
  assert.equal(messages.length, 3);
  assert.equal(messages[0].info.role, 'user');
  assert.deepEqual(messages[0].info.summary, { diffs: [] });
  assert.equal(messages[0].parts[0].text, 'say hi');
  assert.equal(messages[1].info.role, 'assistant');
  assert.equal(messages[1].info.parentID, messages[0].info.id);
  assert.deepEqual(messages[1].parts.map((part) => part.type), ['step-start', 'text', 'step-finish']);
  assert.equal(messages[1].parts[1].text, 'HELLO!');
  assert.match(messages[1].parts[0].snapshot, /^[0-9a-f]{40}$/u);
  assert.equal(messages[2].info.type, 'idle');
  assert.equal(messages[2].info.outcome, 'succeeded');
  assert.match(messages[2].info.id, /^msg_/u);
  assert.deepEqual(messages[2].parts, []);
});

test('OpenCode publishes scoped compaction lifecycle without altering assistant text', async () => {
  let wireSession;
  const bus = recordingBus();
  const record = makeRecord(async () => {
    for (const status of ['started', 'completed', 'skipped', 'failed']) {
      wireSession.observe({ type: 'context_compaction_status', turn_id: 'turn_a', status,
        trigger: 'tool_payload_budget', before_estimated_tokens: 1000,
        after_estimated_tokens: status === 'completed' ? 600 : undefined });
    }
    return { outcome: 'completed', text: 'Answer' };
  });
  wireSession = freshWireSession(record, bus);
  const response = await wireSession.prompt([{ type: 'text', text: 'hello' }]);
  const events = bus.frames.filter((frame) => frame.type === 'nna.context.compaction');
  assert.deepEqual(events.map((frame) => frame.properties.status), ['started', 'completed', 'skipped', 'failed']);
  assert.ok(events.every((frame) => frame.properties.sessionID === 'ses_t' && frame.properties.turnID === 'turn_a'));
  assert.equal(events[1].properties.afterEstimatedTokens, 600);
  assert.equal(response.parts.find((part) => part.type === 'text').text, 'Answer');
  // Compatibility: a client announces a finished compaction only from
  // session.compaction.ended, and only a settled compaction counts as one.
  const ended = bus.frames.filter((frame) => frame.type === 'session.compaction.ended');
  assert.deepEqual(ended.map((frame) => frame.properties.sessionID), ['ses_t', 'ses_t']);
});

test('prompts while busy queue their durable events at admit time and serialize turns', async () => {
  let active;
  const bus = recordingBus();
  const release = [];
  const record = makeRecord((command) => new Promise((resolve) => release.push(() => resolve({ outcome: 'completed', text: `done:${command.content}` }))));
  const wireSession = freshWireSession(record, bus);
  active = wireSession;
  const first = wireSession.prompt([{ type: 'text', text: 'one' }]);
  const second = wireSession.prompt([{ type: 'text', text: 'two' }]);
  assert.equal(wireSession.pendingCount(), 2);
  const userMessages = bus.frames.filter((frame) => frame.type === 'message.updated' && frame.properties.info?.role === 'user');
  assert.equal(userMessages.length, 2, 'both prompts carry user events at admit time');
  assert.equal(bus.frames.filter((frame) => frame.properties.info?.role === 'assistant').length, 0, 'no assistant events until the first turn actually starts');
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.shift()();
  const firstResponse = await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.shift()();
  const secondResponse = await second;
  assert.equal(firstResponse.parts[1].text, 'done:one');
  assert.equal(secondResponse.parts[1].text, 'done:two');
  const idleBares = bus.frames.filter((frame) => frame.type === 'session.idle');
  assert.equal(idleBares.length, 2);
  // Two turns, each followed by its idle marker.
  assert.equal(wireSession.messages().length, 6);
});

test('completed prompts release queue capacity while recent wire history stays bounded', async () => {
  const record = makeRecord(async ({ content }) => ({ outcome: 'completed', text: `done:${content}` }));
  const wireSession = freshWireSession(record, { publishSession() {} });
  for (let index = 0; index < 65; index += 1) {
    const response = await wireSession.prompt([{ type: 'text', text: `prompt-${index}` }]);
    assert.equal(response.info.finish, 'stop');
    assert.equal(wireSession.pendingCount(), 0);
  }
  const messages = wireSession.messages();
  // Each retained turn is a user record, an assistant record, and its idle marker.
  assert.equal(messages.length, 192, 'only the latest 64 turns remain in wire history');
  assert.equal(messages[0].parts[0].text, 'prompt-1');
  assert.equal(messages.at(-3).parts[0].text, 'prompt-64');
});

test('the queue rejects a 65th unfinished prompt and accepts work after settlement', async () => {
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, { publishSession() {} });
  const pending = Array.from({ length: 64 }, (_, index) => wireSession.prompt([{ type: 'text', text: `queued-${index}` }]));
  assert.equal(wireSession.pendingCount(), 64);
  assert.throws(() => wireSession.prompt([{ type: 'text', text: 'overflow' }]), { code: 'opencode_prompt_queue_overflow' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wireSession.abort(), 63);
  release({ outcome: 'completed', text: 'done' });
  await Promise.all(pending);
  assert.equal(wireSession.pendingCount(), 0);
  const next = wireSession.prompt([{ type: 'text', text: 'after' }]);
  await new Promise((resolve) => setImmediate(resolve));
  release({ outcome: 'completed', text: 'after' });
  assert.equal((await next).parts[1].text, 'after');
});

test('tool status records become tool parts on the assistant message', async () => {
  const bus = recordingBus();
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, bus);
  const pending = wireSession.prompt([{ type: 'text', text: 'use a tool' }]);
  await new Promise((resolve) => setImmediate(resolve));
  wireSession.observe({ type: 'tool_status', tool: 'file_read', tool_request_id: 'req_1', status: 'running' });
  wireSession.observe({ type: 'tool_status', tool: 'file_read', tool_request_id: 'req_1', status: 'succeeded' });
  release({ outcome: 'completed', text: 'done' });
  const response = await pending;
  const tools = response.parts.filter((part) => part.type === 'tool');
  // Invariant: one part per tool request, updated in place rather than appended
  // once per lifecycle record.
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'file_read');
  assert.equal(tools[0].state.status, 'completed');
  assert.equal(tools[0].messageID, response.info.id);
  assert.match(tools[0].id, /^prt_/u);
  assert.equal(typeof tools[0].time.completed, 'number');
  // The tool sits between the step's opening and its finish.
  assert.equal(response.parts[0].type, 'step-start');
  assert.equal(response.parts.at(-1).type, 'step-finish');
});

test('a failed tool reports fixed guidance without engine detail', async () => {
  const bus = recordingBus();
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, bus);
  const pending = wireSession.prompt([{ type: 'text', text: 'fail a tool' }]);
  await new Promise((resolve) => setImmediate(resolve));
  wireSession.observe({ type: 'tool_status', tool: 'shell_run', tool_request_id: 'req_2', status: 'failed' });
  release({ outcome: 'completed', text: 'ok' });
  const response = await pending;
  const tool = response.parts.find((part) => part.type === 'tool');
  assert.equal(tool.state.status, 'error');
  // Security: the wire carries fixed guidance, never a raw tool result, and a
  // tool's input can contain a secret.
  assert.equal(tool.state.error.type, 'nna_tool_failed');
  assert.equal(Object.keys(tool.state.input).length, 0);
});

test('a protocol tool never appears as a tool part', async () => {
  const bus = recordingBus();
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, bus);
  const pending = wireSession.prompt([{ type: 'text', text: 'declare an outcome' }]);
  await new Promise((resolve) => setImmediate(resolve));
  // Why: turn_finish declares the turn's outcome; it is not work the model did,
  // and OpenCode has no call to show for it.
  wireSession.observe({ type: 'tool_status', tool: 'turn_finish', tool_request_id: 'req_finish', status: 'running' });
  release({ outcome: 'completed', text: 'done' });
  const response = await pending;
  assert.deepEqual(response.parts.filter((part) => part.type === 'tool'), []);
  assert.deepEqual(response.parts.map((part) => part.type), ['step-start', 'text', 'step-finish']);
});

test('a tool lifecycle is announced in the vocabulary the live transcript reads', async () => {
  // Why: the OpenChamber client renders a live tool row only from the
  // session.tool.* lifecycle — it has no reducer case for message.part.updated.
  // A running tool, then its success, must move the row streaming → running →
  // completed in the order the client's reducer requires.
  const bus = recordingBus();
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, bus);
  const pending = wireSession.prompt([{ type: 'text', text: 'use a tool' }]);
  await new Promise((resolve) => setImmediate(resolve));
  wireSession.observe({ type: 'tool_status', tool: 'file_read', tool_request_id: 'req_l', status: 'running' });
  wireSession.observe({ type: 'tool_status', tool: 'file_read', tool_request_id: 'req_l', status: 'succeeded' });
  release({ outcome: 'completed', text: 'done' });
  await pending;
  const lifecycle = bus.frames.filter((frame) => frame.type.startsWith('session.tool.'));
  const response = wireSession.messages().find((item) => item.info.role === 'assistant');
  const toolId = response.parts.find((part) => part.type === 'tool').id;
  // The two records collapse to one row: open once, move to running once, close once.
  assert.deepEqual(lifecycle.map((frame) => frame.type), [
    'session.tool.input.started', 'session.tool.called', 'session.tool.success',
  ]);
  // Invariant: every event joins to the same row by the part's own id and its
  // assistant message, which is how the client finds the tool to edit.
  for (const frame of lifecycle) {
    assert.equal(frame.properties.id, toolId);
    assert.equal(frame.properties.assistantMessageID, response.info.id);
    assert.equal(frame.properties.sessionID, 'ses_t');
  }
  assert.equal(lifecycle[0].properties.name, 'file_read');
  assert.equal(lifecycle[1].properties.executed, true);
  // Security: `called` opens the row with an empty input, never the arguments.
  assert.deepEqual(lifecycle[1].properties.input, {});
  assert.equal(lifecycle[2].properties.executed, true);
  // Security: the success content is a fixed empty text cell, not the tool result.
  assert.deepEqual(lifecycle[2].properties.content, [{ type: 'text', text: '' }]);
});

test('a single terminal tool record still opens its row before closing it', async () => {
  // Why: the engine can report only a tool's final status. The client drops a
  // success unless the row is already running and a failure unless it is
  // streaming or running, so a lone terminal record must be preceded by the
  // events that open the row, or the tool never appears.
  for (const [status, close] of [['succeeded', 'session.tool.success'], ['failed', 'session.tool.failed']]) {
    const bus = recordingBus();
    let release;
    const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
    const wireSession = freshWireSession(record, bus);
    const pending = wireSession.prompt([{ type: 'text', text: 'one record' }]);
    await new Promise((resolve) => setImmediate(resolve));
    wireSession.observe({ type: 'tool_status', tool: 'shell_run', tool_request_id: `req_${status}`, status });
    release({ outcome: 'completed', text: 'done' });
    await pending;
    const lifecycle = bus.frames.filter((frame) => frame.type.startsWith('session.tool.'));
    assert.deepEqual(lifecycle.map((frame) => frame.type), [
      'session.tool.input.started', 'session.tool.called', close,
    ], status);
  }
});

test('a tool stopped before it ran is reported as not executed', async () => {
  // Why: a review denial ends a tool that never reached running. `executed` is
  // what NNA observed — claiming a denied tool ran would misreport the turn.
  const bus = recordingBus();
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, bus);
  const pending = wireSession.prompt([{ type: 'text', text: 'deny a tool' }]);
  await new Promise((resolve) => setImmediate(resolve));
  // A review-pending record that then goes to a terminal denial without running.
  wireSession.observe({ type: 'tool_status', tool: 'shell_run', tool_request_id: 'req_d', status: 'review_pending' });
  wireSession.observe({ type: 'tool_status', tool: 'shell_run', tool_request_id: 'req_d', status: 'denied' });
  release({ outcome: 'completed', text: 'done' });
  await pending;
  const lifecycle = bus.frames.filter((frame) => frame.type.startsWith('session.tool.'));
  // review_pending opened and ran the row; only the failure closes it.
  assert.deepEqual(lifecycle.map((frame) => frame.type), [
    'session.tool.input.started', 'session.tool.called', 'session.tool.failed',
  ]);
  // The tool reached running, so it did execute even though it was then denied.
  assert.equal(lifecycle[1].properties.executed, true);
  assert.equal(lifecycle[2].properties.executed, true);
  assert.equal(lifecycle[2].properties.error.type, 'nna_tool_failed');
});

test('a pure terminal failure on an unseen tool reports not executed', async () => {
  // Why: a tool denied before it ever reached running must not claim it ran.
  const bus = recordingBus();
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, bus);
  const pending = wireSession.prompt([{ type: 'text', text: 'fail cold' }]);
  await new Promise((resolve) => setImmediate(resolve));
  wireSession.observe({ type: 'tool_status', tool: 'shell_run', tool_request_id: 'req_cold', status: 'denied' });
  release({ outcome: 'completed', text: 'done' });
  await pending;
  const lifecycle = bus.frames.filter((frame) => frame.type.startsWith('session.tool.'));
  assert.deepEqual(lifecycle.map((frame) => frame.type), [
    'session.tool.input.started', 'session.tool.called', 'session.tool.failed',
  ]);
  assert.equal(lifecycle[1].properties.executed, false);
  assert.equal(lifecycle[2].properties.executed, false);
});

test('a protocol tool is announced in neither the part stream nor the lifecycle', async () => {
  // Why: turn_finish declares the outcome; publishing it as a tool, in either
  // vocabulary, would invent a step the model never performed.
  const bus = recordingBus();
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, bus);
  const pending = wireSession.prompt([{ type: 'text', text: 'declare' }]);
  await new Promise((resolve) => setImmediate(resolve));
  wireSession.observe({ type: 'tool_status', tool: 'turn_finish', tool_request_id: 'req_f', status: 'succeeded' });
  release({ outcome: 'completed', text: 'done' });
  await pending;
  assert.deepEqual(bus.frames.filter((frame) => frame.type.startsWith('session.tool.')), []);
});

test('a provider recovery is announced once as a scheduled retry', async () => {
  const bus = recordingBus();
  let release;
  const record = makeRecord(() => new Promise((resolve) => { release = resolve; }));
  const wireSession = freshWireSession(record, bus);
  const pending = wireSession.prompt([{ type: 'text', text: 'recover' }]);
  await new Promise((resolve) => setImmediate(resolve));
  // Why: a recovering turn is still busy, so the client needs the retry status
  // to explain the wait instead of showing a silently stalled turn.
  wireSession.observe({ type: 'state_status', semantic_state: 'recovering' });
  wireSession.observe({ type: 'state_status', semantic_state: 'recovering' });
  wireSession.observe({ type: 'state_status', semantic_state: 'generating' });
  const retries = bus.frames.filter((frame) => frame.type === 'session.retry.scheduled');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].properties.sessionID, 'ses_t');
  assert.match(retries[0].properties.error.message, /provider is unavailable/u);
  release({ outcome: 'completed', text: 'done' });
  await pending;
});

test('prompt validation rejects empty, oversized, and non-text parts before any event', async () => {
  const bus = recordingBus();
  const record = makeRecord(async () => ({ outcome: 'completed', text: '' }));
  record.engine = { ingressContextWindowTokens: 1 };
  const wireSession = freshWireSession(record, bus);
  assert.throws(() => wireSession.prompt([]), /at least one text part/u);
  assert.throws(() => wireSession.prompt([{ type: 'file', mime: 'text/x' }]), /only text prompt parts/u);
  assert.throws(() => wireSession.prompt([{ type: 'text', text: '' }]), /require text/u);
  const oversized = { type: 'text', text: '.'.repeat(65) };
  assert.throws(() => wireSession.prompt([oversized]), /exceeds bounds/u);
  assert.throws(() => wireSession.prompt([{ type: 'text', text: '.'.repeat(40) },
    { type: 'text', text: '.'.repeat(24) }]), /combined prompt text exceeds bounds/u);
  assert.equal(bus.frames.length, 0, 'the recording stub emits nothing; validation rejects before lift-off');
});

test('prompt admission accepts token-valid text beyond the former character ceiling', async () => {
  const record = makeRecord(async (command) => ({ outcome: 'completed', text: command.content }));
  record.engine = { ingressContextWindowTokens: 300_000 };
  const wireSession = freshWireSession(record, recordingBus());
  const text = '界'.repeat(70_000);
  const response = await wireSession.prompt([{ type: 'text', text }]);
  assert.equal(response.parts[1].text, text);
});

test('turn failures still answer with a settled assistant response and idle sentinels', async () => {
  let active;
  const bus = recordingBus();
  const record = makeRecord(async () => { throw Object.assign(new Error('provider died'), { code: 'provider_failure' }); });
  const wireSession = freshWireSession(record, bus);
  active = wireSession;
  await assert.rejects(() => wireSession.prompt([{ type: 'text', text: 'boom' }]), /provider died/u);
  // A failed turn still closes, so it also carries the idle marker that ends it.
  assert.equal(wireSession.messages().length, 3);
  const messages = wireSession.messages();
  assert.equal(messages[1].info.finish, 'error');
  assert.deepEqual(messages[1].info.tokens, { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.equal(messages[1].parts[1].text, '');
  assert.equal(messages[2].info.type, 'idle');
  assert.equal(messages[2].info.outcome, 'failed');
  assert.deepEqual(bus.frames.filter((frame) => frame.type === 'session.idle').length, 1);
});

test('buildPromptCommand joins text parts and snapshotValue is printable hex', () => {
  assert.equal(buildPromptCommand([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.match(snapshotValue('C:\\workspace'), /^[0-9a-f]{40}$/u);
});
