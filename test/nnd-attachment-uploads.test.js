// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { NndAttachmentUploads } from '../src/nnd-attachment-uploads.js';

const input = (upload_id = 'upload_one', content = 'fixture text') => ({
  upload_id, filename: 'notes.txt', mime_type: 'text/plain',
  data_url: `data:text/plain;base64,${Buffer.from(content).toString('base64')}`,
});

test('native uploads are session and principal bound, idempotent, and consumed by one submission', () => {
  const uploads = new NndAttachmentUploads();
  const receipt = uploads.upload('session_one', 'owner', input(), 1_000_000);
  assert.equal(receipt.bytes, 12);
  assert.deepEqual(uploads.upload('session_one', 'owner', input(), 1_000_000), receipt);
  assert.deepEqual(uploads.assertRefs('session_one', 'owner', 'request_one', [{ upload_id: 'upload_one' }]),
    [{ upload_id: 'upload_one', mime_type: 'text/plain', filename: 'notes.txt' }]);
  assert.equal(uploads.resolve('session_one', 'upload_one', 'text/plain').bytes.toString(), 'fixture text');
  assert.throws(() => uploads.assertRefs('session_two', 'owner', 'request_one', [{ upload_id: 'upload_one' }]),
    { code: 'nnd_attachment_upload_expired' });
  assert.throws(() => uploads.assertRefs('session_one', 'intruder', 'request_one', [{ upload_id: 'upload_one' }]),
    { code: 'nnd_attachment_upload_scope_denied' });
  uploads.markUsed('session_one', 'request_one', [{ upload_id: 'upload_one' }]);
  assert.throws(() => uploads.assertRefs('session_one', 'owner', 'request_two', [{ upload_id: 'upload_one' }]),
    { code: 'nnd_attachment_upload_scope_denied' });
  uploads.release('session_one', 'request_one');
  assert.throws(() => uploads.resolve('session_one', 'upload_one', 'text/plain'),
    { code: 'nnd_attachment_upload_expired' });
});

test('native upload rejects changed identity, malformed bytes, unsafe names, and expired references', () => {
  let now = 0;
  const uploads = new NndAttachmentUploads(() => now);
  uploads.upload('session', 'owner', input(), 1_000_000);
  assert.throws(() => uploads.upload('session', 'owner', input('upload_one', 'changed'), 1_000_000),
    { code: 'nnd_attachment_upload_conflict' });
  assert.throws(() => uploads.upload('session', 'owner', { ...input('bad'), filename: '../bad' }, 1_000_000),
    { code: 'nnd_attachment_upload_invalid' });
  assert.throws(() => uploads.upload('session', 'owner', { ...input('bad'), data_url: 'data:text/plain;base64,***' }, 1_000_000),
    { code: 'nnd_attachment_upload_invalid' });
  assert.throws(() => uploads.upload('session', 'owner', input('large', 'a'.repeat(65_537)), 1_000_000),
    { code: 'attachment_invalid' });
  now = 600_001;
  assert.throws(() => uploads.assertRefs('session', 'owner', 'request', [{ upload_id: 'upload_one' }]),
    { code: 'nnd_attachment_upload_expired' });
});
