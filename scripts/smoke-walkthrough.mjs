// SPDX-License-Identifier: Apache-2.0
/** Exercises the explicit, model-only NND→NNA walkthrough integration seam. */
import assert from 'node:assert/strict';

const SYSTEM_PREFIX = 'You explain a software diff to its author.';

export function walkthroughProviderReply(body) {
  if (!body.messages?.[0]?.content?.startsWith(SYSTEM_PREFIX)) return null;
  return JSON.stringify({ chapters: [{ title: 'Smoke change', stops: [
    { alias: 'h1', explanation: 'The new value replaces the old value.' },
  ] }] });
}

export async function probeWalkthrough(call, json, sessionId, providerRequests) {
  const revision = 'a'.repeat(64);
  const result = await json(call, `/api/v1/nnd/sessions/${sessionId}/walkthrough`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision,
      digest: [{ alias: 'h1', scope: 'working', path: 'smoke.ts', header: '@@ -1 +1 @@', patch: '-old\n+new' }] }),
  }, 200);
  assert.equal(result.revision, revision, 'NNA did not preserve the diff revision');
  assert.equal(JSON.parse(result.text).chapters[0].stops[0].alias, 'h1');
  assert.deepEqual([result.providerID, result.modelID], ['primary', 'test']);
  assert.ok(providerRequests().some((request) => request.messages?.[0]?.content?.startsWith(SYSTEM_PREFIX)
    && (request.tools === undefined || Array.isArray(request.tools) && request.tools.length === 0)),
  'walkthrough did not use the model-only route');
}
