// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDesktopDeepLinks, parseDesktopDeepLink } from './deep-links.mjs';

test('accepts only session and focus links with bounded session identifiers', () => {
  assert.deepEqual(parseDesktopDeepLink('openchamber://focus'), { type: 'focus' });
  assert.deepEqual(parseDesktopDeepLink('openchamber://session/ses_123'), { type: 'session', sessionId: 'ses_123' });
  assert.deepEqual(parseDesktopDeepLink('openchamber://session/ses%3A123'), { type: 'session', sessionId: 'ses:123' });
  assert.equal(parseDesktopDeepLink(`openchamber://session/${'x'.repeat(501)}`), null);
});

test('rejects link variants that could smuggle another action or malformed path', () => {
  for (const value of [
    'https://session/ses_1', 'openchamber://user@session/ses_1', 'openchamber://session:99/ses_1',
    'openchamber://session/ses_1?next=https://evil.test', 'openchamber://session/a%2Fb',
    'openchamber://session/%00', 'openchamber://connect?v=2&p=payload', 'openchamber://focus/extra',
  ]) assert.equal(parseDesktopDeepLink(value), null, value);
});

test('extracts supported links from launch arguments and ignores unrelated arguments', () => {
  assert.deepEqual(extractDesktopDeepLinks(['--hidden', 'openchamber://session/s1', 'https://example.test', 'openchamber://focus']), [
    { type: 'session', sessionId: 's1' }, { type: 'focus' },
  ]);
});
