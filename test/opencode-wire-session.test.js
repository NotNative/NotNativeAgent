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
  assert.equal(messages.length, 2);
  assert.equal(messages[0].info.role, 'user');
  assert.deepEqual(messages[0].info.summary, { diffs: [] });
  assert.equal(messages[0].parts[0].text, 'say hi');
  assert.equal(messages[1].info.role, 'assistant');
  assert.equal(messages[1].info.parentID, messages[0].info.id);
  assert.deepEqual(messages[1].parts.map((part) => part.type), ['step-start', 'text', 'step-finish']);
  assert.equal(messages[1].parts[1].text, 'HELLO!');
  assert.match(messages[1].parts[0].snapshot, /^[0-9a-f]{40}$/u);
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
  assert.equal(wireSession.messages().length, 4);
});

test('prompt validation rejects empty, oversized, and non-text parts before any event', async () => {
  const bus = recordingBus();
  const record = makeRecord(async () => ({ outcome: 'completed', text: '' }));
  record.engine = { ingressContextWindowTokens: 1 };
  const wireSession = freshWireSession(record, bus);
  assert.throws(() => wireSession.prompt([]), /at least one text part/u);
  assert.throws(() => wireSession.prompt([{ type: 'file', mime: 'text/x' }]), /only text prompt parts/u);
  assert.throws(() => wireSession.prompt([{ type: 'text', text: '' }]), /require text/u);
  const oversized = { type: 'text', text: '.'.repeat(769) };
  assert.throws(() => wireSession.prompt([oversized]), /exceeds bounds/u);
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
  assert.equal(wireSession.messages().length, 2);
  const messages = wireSession.messages();
  assert.equal(messages[1].info.finish, 'error');
  assert.deepEqual(messages[1].info.tokens, { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.equal(messages[1].parts[1].text, '');
  assert.deepEqual(bus.frames.filter((frame) => frame.type === 'session.idle').length, 1);
});

test('buildPromptCommand joins text parts and snapshotValue is printable hex', () => {
  assert.equal(buildPromptCommand([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.match(snapshotValue('C:\\workspace'), /^[0-9a-f]{40}$/u);
});
