// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { restoreNativeContinuity, takeNativeResumeSelection, finishNativeContinuity } from '../native-continuity.ts';
beforeEach(() => { localStorage.clear(); finishNativeContinuity('native:here'); });
const snapshot = () => ({ runtime: 'native:here', drafts: JSON.stringify({ 'native:here\n/work\ns1': { text: 'unsent' } }),
  lastSession: JSON.stringify({ version: 1, runtimes: { 'native:here': { sessionId: 's1', directory: '/work', updatedAt: 1 } } }) });
it('restores unsent content and selection in the new origin without copying arbitrary storage', () => {
  localStorage.setItem('unrelated', 'keep'); restoreNativeContinuity(snapshot(), 'native:here');
  expect(JSON.parse(localStorage.getItem('nnd.draft.v1')!)['native:here\n/work\ns1'].text).toBe('unsent');
  expect(JSON.parse(localStorage.getItem('nnd.lastSession.v1')!).runtimes['native:here'].sessionId).toBe('s1');
  expect(localStorage.getItem('unrelated')).toBe('keep');
  expect(takeNativeResumeSelection('native:here')).toEqual({ runtime: 'native:here', sessionId: 's1', directory: '/work' });
  expect(takeNativeResumeSelection('native:here')).toBeNull();
});
it.each([
  { runtime: 'native:other' }, { drafts: '{broken' }, { drafts: JSON.stringify({ 'native:other\n/x\ns2': {} }) },
  { lastSession: JSON.stringify({ version: 1, runtimes: { 'native:other': {} } }) }, { drafts: 'x'.repeat(4 * 1024 * 1024) },
])('refuses foreign or corrupt cache without writing any of it: %s', patch => {
  expect(() => restoreNativeContinuity({ ...snapshot(), ...patch }, 'native:here')).toThrow();
  expect(localStorage.getItem('nnd.draft.v1')).toBeNull(); expect(localStorage.getItem('nnd.lastSession.v1')).toBeNull();
});
