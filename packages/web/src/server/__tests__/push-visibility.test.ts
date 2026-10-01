// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { PushVisibility } from '../push/visibility.ts';

describe('push visibility leases', () => {
  it('aggregates tabs and ignores delayed or duplicated writes', () => {
    const leases = new PushVisibility(() => 100);
    leases.update('owner', { visible: true, clientId: 'tab-a', sequence: 1 });
    leases.update('owner', { visible: false, clientId: 'tab-b', sequence: 1 });
    expect(leases.visible('owner')).toBe(true);
    expect(leases.visible('other')).toBe(false);
    leases.update('owner', { visible: false, clientId: 'tab-a', sequence: 3 });
    leases.update('owner', { visible: true, clientId: 'tab-a', sequence: 2 });
    leases.update('owner', { visible: true, clientId: 'tab-a', sequence: 3 });
    expect(leases.visible('owner')).toBe(false);
  });
  it('expires leases while retaining ordering until tombstones expire', () => {
    let now = 0; const leases = new PushVisibility(() => now);
    leases.update('owner', { visible: true, clientId: 'tab', sequence: 10 });
    now = 29_999; expect(leases.visible('owner')).toBe(true);
    now = 30_000; expect(leases.visible('owner')).toBe(false);
    leases.update('owner', { visible: true, clientId: 'tab', sequence: 9 });
    expect(leases.visible('owner')).toBe(false);
    now = 300_000;
    leases.update('owner', { visible: true, clientId: 'tab', sequence: 1 });
    expect(leases.visible('owner')).toBe(true);
  });
  it('retains the legacy boolean contract', () => {
    const leases = new PushVisibility();
    leases.update('owner', { visible: true }); expect(leases.visible('owner')).toBe(true);
    leases.update('owner', { visible: false }); expect(leases.visible('owner')).toBe(false);
  });
  it.each([{ visible: 'true' }, { visible: true, clientId: '../../bad' }, { visible: true, sequence: -1 }, { visible: true, sequence: 1.5 }])('rejects invalid presence %s', (input) => {
    expect(() => new PushVisibility().update('owner', input)).toThrow();
  });
  it('bounds tab capacity without evicting a visible tab and reclaims expired entries', () => {
    let now = 0; const leases = new PushVisibility(() => now);
    for (let index = 0; index < 32; index += 1) leases.update('owner', { visible: true, clientId: `tab-${index}`, sequence: 1 });
    expect(() => leases.update('owner', { visible: false, clientId: 'extra', sequence: 1 })).toThrow('capacity');
    expect(leases.visible('owner')).toBe(true);
    now = 300_000;
    expect(() => leases.update('owner', { visible: true, clientId: 'extra', sequence: 1 })).not.toThrow();
  });
});
