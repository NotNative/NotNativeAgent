// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessClient } from '../client.ts';
import {
  __resetSteeringSnapshotsForTests, refreshSteeringCapability, steeringAllowed,
  steeringSnapshot, subscribeSteering,
} from '../steering-capability.ts';

const granted = { data: { session_id: 'agent_1', revision: 1, capabilities: { steer_subagent: true }, availability: 'granted' } };
const denied = { data: { session_id: 'agent_1', revision: 2, capabilities: { steer_subagent: false }, availability: 'unavailable' } };

beforeEach(() => { __resetSteeringSnapshotsForTests(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('steering capability snapshot', () => {
  it('dedupes concurrent refreshes into one GET and notifies subscribers', async () => {
    let release: (value: unknown) => void = () => undefined;
    const capability = vi.spyOn(harnessClient, 'childSteeringCapability').mockImplementation(() =>
      new Promise((resolve) => { release = resolve as (value: unknown) => void; }));
    const seen: string[] = [];
    const unsubscribe = subscribeSteering((key) => seen.push(key));
    const first = refreshSteeringCapability('agent_1', 'D:/work');
    const second = refreshSteeringCapability('agent_1', 'D:/work');
    expect(capability).toHaveBeenCalledTimes(1);
    release!(granted);
    await Promise.all([first, second]);
    expect(steeringAllowed('agent_1', 'D:/work')).toBe(true);
    expect(seen).toEqual([`${'D:/work'}\u0000agent_1`]);
    unsubscribe();
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    vi.spyOn(harnessClient, 'childSteeringCapability')
      .mockResolvedValueOnce(granted)
      .mockRejectedValueOnce(new Error('offline'));
    await refreshSteeringCapability('agent_1', 'D:/work');
    const before = steeringSnapshot('agent_1', 'D:/work');
    const after = await refreshSteeringCapability('agent_1', 'D:/work');
    expect(after).toBe(before); // the failed read leaves the old snapshot
    expect(steeringAllowed('agent_1', 'D:/work')).toBe(true);
  });

  it('does not let a colliding directory seed another root', async () => {
    vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue(granted);
    await refreshSteeringCapability('agent_1', 'D:/other');
    expect(steeringAllowed('agent_1', 'D:/work')).toBe(false);
  });
});
