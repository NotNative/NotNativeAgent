// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { safeReviewRequest } from '../src/reviewer-packet.js';

function packet(toolName, args, resolved = { source: 'external' }) {
  return safeReviewRequest({ id: 'request-1', toolName, args, resolved, caller: 'primary' }, false);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

test('line edits send replacement size and digest without authored text', () => {
  const replacement = 'private replacement';
  const review = packet('fs_edit_lines', {
    path: 'file.txt', start_line: 1, end_line: 2, replacement,
  }, { path: 'file.txt' });
  assert.equal(review.args.replacement, undefined);
  assert.equal(review.args.replacement_bytes, Buffer.byteLength(replacement, 'utf8'));
  assert.equal(review.args.replacement_sha256, sha256(replacement));
  assert.equal(JSON.stringify(review).includes(replacement), false);
});

test('process argv redacts values following sensitive flags', () => {
  const review = packet('process_run', { executable: 'probe', args: [
    '--format', 'json', '--token', 'private-value', '-api-key', 'another-private-value',
    '--access_token', 'third-private-value', '--tokenizer', 'simple',
  ] }, { path: 'workspace' });
  assert.deepEqual(review.args.args, [
    '--format', 'json', '--token', '[redacted]', '-api-key', '[redacted]',
    '--access_token', '[redacted]', '--tokenizer', 'simple',
  ]);
  assert.equal(JSON.stringify(review).includes('private-value'), false);
});

test('authorization fields and external argv arrays redact credentials', () => {
  const review = packet('mcp_request', {
    headers: { Authorization: 'Basic private-value' },
    argv: ['--auth-token', 'another-private-value', '--format', 'json'],
  });
  assert.equal(review.args.headers.Authorization, '[redacted]');
  assert.deepEqual(review.args.argv, ['--auth-token', '[redacted]', '--format', 'json']);
});

test('secret flags and authorization headers inside scripts do not enter the packet', () => {
  for (const script of ['probe --token private-value', 'probe -H "Authorization: Basic private-value"']) {
    const review = packet('shell_run', { script }, { path: 'workspace' });
    assert.equal(review.args.script, '[redacted]');
    assert.equal(JSON.stringify(review).includes('private-value'), false);
  }
});

test('external content keeps other review-relevant fields', () => {
  const review = packet('mcp_send_message', {
    content: 'opaque-private-payload', destination: 'mail@example.com', metadata: { secrets: ['private-value'] },
  });
  assert.equal(review.args.content, undefined);
  assert.equal(review.args.content_bytes, Buffer.byteLength('opaque-private-payload', 'utf8'));
  assert.equal(review.args.content_sha256, sha256('opaque-private-payload'));
  assert.equal(review.args.destination, 'mail@example.com');
  assert.equal(review.args.metadata.secrets, '[redacted]');
  assert.equal(JSON.stringify(review).includes('opaque-private-payload'), false);
});

test('file writes hash content and preserve path context', () => {
  const review = packet('fs_write_text', { path: 'file.txt', content: 'private bytes' }, { path: 'file.txt' });
  assert.equal(review.args.content, undefined);
  assert.equal(review.args.content_sha256, sha256('private bytes'));
  assert.equal(review.args.path, 'file.txt');
});

test('packet tolerates malformed direct helper inputs', () => {
  const review = packet('mcp_tool', undefined, null);
  assert.deepEqual(review.args, {});
  assert.equal(review.resolvedTarget, 'external');
});
