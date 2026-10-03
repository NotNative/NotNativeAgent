// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityGapAt, markActivityGap, subscribeActivityGap } from '../activity-gap.ts';

afterEach(() => window.localStorage.clear());

describe('Activity stream gap evidence', () => {
  it('persists an explicit gap only for its stable runtime and not for a transient boot key', () => {
    let notifications = 0;
    const unsubscribe = subscribeActivityGap(() => { notifications += 1; });
    markActivityGap('local', 1_700_000_000_000);
    expect(activityGapAt('local')).toBe(1_700_000_000_000);
    expect(activityGapAt('url:https://other.example')).toBeNull();
    expect(window.localStorage.getItem('nnd.activity-gap.v1:local')).toBe('1700000000000');
    markActivityGap('url:default', 1_700_000_000_001);
    expect(activityGapAt('url:default')).toBe(1_700_000_000_001);
    expect(window.localStorage.getItem('nnd.activity-gap.v1:url%3Adefault')).toBeNull();
    unsubscribe();
    expect(notifications).toBe(2);
  });

  it('does not treat malformed storage as a history gap', () => {
    window.localStorage.setItem('nnd.activity-gap.v1:local', 'not-a-date');
    expect(activityGapAt('local')).toBeNull();
  });
  it('keeps explicit gap evidence visible when storage is readable but a write is denied', () => {
    const runtime = 'url:https://quota.example';
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota'); });
    markActivityGap(runtime, 1_700_000_000_002);
    expect(activityGapAt(runtime)).toBe(1_700_000_000_002);
    setItem.mockRestore();
  });
});
