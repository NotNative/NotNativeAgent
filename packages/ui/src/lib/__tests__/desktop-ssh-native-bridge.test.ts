// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { createDesktopSshNativeBridge } from '../desktopSshNativeBridge.ts';

describe('desktop SSH native bridge', () => {
  it('unwraps successful invoke replies and reads only through the SSH config command', async () => {
    const invoke = vi.fn(async (command: string) => command === 'desktopSshReadConfig'
      ? { ok: true, result: 'Host studio\n' }
      : { ok: true, result: { instances: [] } });
    const bridge = createDesktopSshNativeBridge({ __NOTNATIVE_DESKTOP_INVOKE__: invoke });
    expect(bridge).not.toBeNull();
    await expect(bridge!.invoke('desktopSshConfig')).resolves.toEqual({ instances: [] });
    await expect(bridge!.readSshConfig()).resolves.toBe('Host studio\n');
    expect(invoke).toHaveBeenNthCalledWith(1, 'desktopSshConfig', undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktopSshReadConfig');
  });

  it('turns rejected invoke envelopes into errors and subscribes/unsubscribes status handlers', async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: 'desktop-ssh-config-invalid' }));
    let statusHandler: ((detail: unknown) => void) | undefined;
    const unsubscribe = vi.fn(() => { statusHandler = undefined; });
    const bridge = createDesktopSshNativeBridge({
      __NOTNATIVE_DESKTOP_INVOKE__: invoke,
      __NOTNATIVE_DESKTOP_EVENTS__: {
        onOpenSession: () => () => {}, onRelayPairingRequest: () => () => {},
        onSshStatus: (handler) => { statusHandler = handler; return unsubscribe; },
      },
    });
    await expect(bridge!.invoke('desktopSshConfig')).rejects.toThrow('desktop-ssh-config-invalid');
    const listener = vi.fn();
    const detach = bridge!.listenStatus(listener);
    const event = { id: 'ssh-studio', phase: 'ready' };
    statusHandler?.(event);
    expect(listener).toHaveBeenCalledWith(event);
    detach();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('is unavailable outside Electron', () => {
    expect(createDesktopSshNativeBridge({})).toBeNull();
  });
});
