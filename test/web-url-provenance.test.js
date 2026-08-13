// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebUrlProvenance, extractWebUrls, normalizeWebUrl } from '../src/web-url-provenance.js';

test('URL provenance records exact user URLs and rejects credentialed URLs', () => {
  const ledger = new WebUrlProvenance('Read https://example.com/docs/page#part, please.');
  assert.deepEqual(ledger.classify('https://example.com/docs/page'), {
    url: 'https://example.com/docs/page', source: 'user', verified: true,
  });
  assert.equal(normalizeWebUrl('https://user:secret@example.com/path'), null);
  assert.deepEqual(extractWebUrls('See https://example.com/a. Then https://example.com/a.'), ['https://example.com/a']);
});

test('URL provenance learns search and browser URLs while labeling guesses unverified', () => {
  const ledger = new WebUrlProvenance();
  ledger.observe({ toolName: 'web.search' }, {
    status: 'succeeded', content: JSON.stringify({ results: [{ url: 'https://example.com/exact' }] }),
  });
  ledger.observe({ toolName: 'web.browse', args: { url: 'https://example.org/start' } }, {
    status: 'succeeded', metadata: { url: 'https://example.org/final' },
  });
  assert.equal(ledger.classify('https://example.com/exact').source, 'search');
  assert.equal(ledger.classify('https://example.org/final').source, 'browser');
  assert.deepEqual(ledger.classify('https://example.net/guessed'), {
    url: 'https://example.net/guessed', source: 'model_unverified', verified: false,
  });
});

test('URL provenance remembers a failed fetch for the remainder of the turn', () => {
  const ledger = new WebUrlProvenance('Try https://example.com/missing');
  const request = { toolName: 'web.fetch', args: { url: 'https://example.com/missing' } };
  ledger.observe(request, { status: 'failed', reason_code: 'web_fetch_http_error' });
  assert.equal(ledger.hasFailed('https://example.com/missing#again'), true);
});
