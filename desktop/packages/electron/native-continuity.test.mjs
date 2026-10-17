// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { captureNativeContinuity } from './native-continuity.mjs';

test('continuity copies only current-runtime drafts and selection, without cookies or credentials', async () => {
  const records = { 'native:here\n/work\ns1': { text: 'keep this unsent text' }, 'native:other\n/x\ns2': { text: 'foreign' } };
  const values = { 'nnd.draft.v1': JSON.stringify(records), 'nnd.lastSession.v1': JSON.stringify({ version: 1, runtimes: {
    'native:here': { sessionId: 's1', directory: '/work', updatedAt: 1 }, 'native:other': { sessionId: 's2' },
  } }), token: 'must not copy' };
  const captured = await captureNativeContinuity({ isDestroyed: () => false,
    executeJavaScript: async source => JSON.parse(JSON.stringify(runInNewContext(source, { localStorage: { getItem: key => values[key] } }))),
  }, 'native:here');
  assert.deepEqual(JSON.parse(captured.drafts), { 'native:here\n/work\ns1': records['native:here\n/work\ns1'] });
  assert.deepEqual(Object.keys(JSON.parse(captured.lastSession).runtimes), ['native:here']);
  assert.equal(JSON.stringify(captured).includes('foreign'), false); assert.equal(JSON.stringify(captured).includes('must not copy'), false);
});

test('unavailable and oversized continuity refuse before restart can discard the renderer', async () => {
  await assert.rejects(captureNativeContinuity(null, 'native:here'), /unavailable/u);
  await assert.rejects(captureNativeContinuity({ isDestroyed: () => false, executeJavaScript: async () => { throw new Error('storage denied'); } }, 'native:here'), /unavailable/u);
  await assert.rejects(captureNativeContinuity({ isDestroyed: () => false, executeJavaScript: async () => ({ runtime: 'native:here', drafts: 'x'.repeat(4 * 1024 * 1024), lastSession: '{}' }) }, 'native:here'), /too-large/u);
});
