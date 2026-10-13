// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { harnessClient } from '../../lib/nnd/client.ts';
import { __resetSteeringSnapshotsForTests, refreshSteeringCapability } from '../../lib/nnd/steering-capability.ts';
import { ChildSessionControls } from '../child-session-controls.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
  __resetSteeringSnapshotsForTests();
});

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ChildSessionControls sessionID="agent_1" directory="D:/work" />); });
}

const granted = { data: { session_id: 'agent_1', revision: 1, capabilities: { steer_subagent: true }, availability: 'granted' } };
const denied = { data: { session_id: 'agent_1', revision: 2, capabilities: { steer_subagent: false }, availability: 'unavailable' } };

describe('child session steering', () => {
  it('keeps the transcript read-only when NNA does not grant steering', async () => {
    const capability = vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue(denied);
    const steer = vi.spyOn(harnessClient, 'steerChildSession');
    await mount();
    expect(container!.textContent).toContain('read-only by default');
    expect(container!.querySelector('textarea')).toBeNull();
    expect(container!.querySelector('button')).toBeNull();
    expect(capability).toHaveBeenCalledWith('agent_1', { directory: 'D:/work' });
    expect(steer).not.toHaveBeenCalled();
  });

  it('requires a click and a fresh grant before sending', async () => {
    const capability = vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue(granted);
    const steer = vi.spyOn(harnessClient, 'steerChildSession').mockResolvedValue({ data: { accepted: true } });
    await mount();
    const toggle = container!.querySelector('button') as HTMLButtonElement;
    expect(toggle.textContent).toBe('Steer subagent');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container!.querySelector('textarea')).toBeNull();
    act(() => toggle.click());
    const input = container!.querySelector('textarea') as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(input, 'Please check the test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (container!.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(capability).toHaveBeenCalledTimes(2);
    expect(steer).toHaveBeenCalledWith('agent_1', expect.objectContaining({ content: 'Please check the test' }), { directory: 'D:/work' });
    expect(container!.textContent).toContain('Steering sent');
    expect(container!.querySelector('textarea')).toBeNull();
  });

  it('does not submit when the grant disappears before the click is confirmed', async () => {
    vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValueOnce(granted).mockResolvedValueOnce(denied);
    const steer = vi.spyOn(harnessClient, 'steerChildSession');
    await mount();
    act(() => (container!.querySelector('button') as HTMLButtonElement).click());
    const input = container!.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(input, 'No longer allowed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (container!.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(steer).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('no longer available');
    expect(container!.querySelector('textarea')).toBeNull();
  });

  it('does not claim delivery when the child turn ends during submission', async () => {
    vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue(granted);
    vi.spyOn(harnessClient, 'steerChildSession').mockResolvedValue({ data: { accepted: false, reason: 'no_active_turn' }, response: { status: 202 } });
    await mount();
    act(() => (container!.querySelector('button') as HTMLButtonElement).click());
    const input = container!.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(input, 'Please continue');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (container!.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(container!.textContent).toContain('could not be confirmed');
    expect(container!.textContent).not.toContain('Steering sent');
    expect((container!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Please continue');
  });

  it('starts from the reconnect-time snapshot instead of a blind reset', async () => {
    // Simulate the reconnect resync refreshing the shared snapshot while no
    // component is mounted.
    vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue(granted);
    await act(async () => { await refreshSteeringCapability('agent_1', 'D:/work'); });
    await mount();
    expect(container!.querySelector('button')?.textContent).toBe('Steer subagent');
    act(() => root!.unmount());
    // A reconnect flips the grant away; the remount must show it immediately,
    // before the first poll tick.
    vi.spyOn(harnessClient, 'childSteeringCapability').mockResolvedValue(denied);
    await act(async () => { await refreshSteeringCapability('agent_1', 'D:/work'); });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<ChildSessionControls sessionID="agent_1" directory="D:/work" />); });
    expect(container!.querySelector('button')).toBeNull();
  });
});
