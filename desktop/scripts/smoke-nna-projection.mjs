// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { eventReader } from './smoke-http.mjs';

async function ports() {
  const { callHarness, harnessRequest } = await import('../packages/web/src/server/queue/queue-adapter-calls.ts');
  const { parseNnaProjection } = await import('../packages/ui/src/sync/nna-projection.ts');
  const call = (path, init = {}) => callHarness(harnessRequest(path, '', { ...init, signal: AbortSignal.timeout(5000) }));
  const snapshot = async (id) => {
    const response = await call(`/session/${encodeURIComponent(id)}`); assert.equal(response.status, 200);
    const session = await response.json(); const frame = parseNnaProjection(session.metadata?.nnd?.projection);
    assert.ok(frame, 'native snapshot lacks a valid versioned projection'); assert.equal(frame.sessionID, id); return frame;
  };
  return { call, snapshot, parseNnaProjection };
}
export async function probeNnaProjection(parentId) {
  const { call, snapshot, parseNnaProjection } = await ports();
  const parentEpoch = (await snapshot(parentId)).epoch;
  const stream = await call('/global/event'); assert.equal(stream.status, 200);
  const reader = stream.body.getReader(); const next = eventReader(reader);
  let id; let cursor; let last; const phases = new Set();
  try {
    const created = await call('/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(created.status, 201); id = (await created.json()).id;
    const prompt = await call(`/session/${id}/prompt_async`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'projection-smoke', model: { providerID: 'primary', modelID: 'test' }, agent: 'nna',
        parts: [{ type: 'text', text: 'Reply with the source smoke marker.' }] }) });
    assert.equal(prompt.status, 204);
    for (let count = 0; count < 1000; count += 1) {
      const envelope = await next(); const payload = envelope.payload;
      if (payload?.type !== 'nnd.projection' || payload.properties?.sessionID !== id) continue;
      const frame = parseNnaProjection(payload.properties.frame); assert.ok(frame);
      cursor ??= payload.id; last = frame; phases.add(frame.turnState?.phase);
      if (frame.turnState?.phase === 'idle') break;
    }
    assert.ok(phases.has('preparing') && phases.has('waiting_provider') && phases.has('streaming') && phases.has('idle'));
    assert.deepEqual(await snapshot(id), last);
  } finally { await reader.cancel(); reader.releaseLock(); }
  const replay = await call('/global/event', { headers: { 'last-event-id': cursor } }); const replayReader = replay.body.getReader();
  try {
    const nextReplay = eventReader(replayReader); let recovered = false;
    for (let count = 0; count < 1000; count += 1) {
      const payload = (await nextReplay()).payload;
      if (payload?.type !== 'nnd.projection' || payload.properties?.sessionID !== id) continue;
      const frame = parseNnaProjection(payload.properties.frame); assert.ok(frame);
      assert.equal(frame.epoch, last.epoch);
      if (frame.revision === last.revision) { recovered = true; break; }
    }
    assert.ok(recovered, 'native replay did not restore the final projection');
  } finally { await replayReader.cancel(); replayReader.releaseLock(); await call(`/session/${id}`, { method: 'DELETE' }); }
  return parentEpoch;
}
export async function probeRestoredProjection(id, priorEpoch) {
  const { snapshot } = await ports(); const frame = await snapshot(id);
  assert.notEqual(frame.epoch, priorEpoch, 'restored engine context reused an old projection epoch');
}
