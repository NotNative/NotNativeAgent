// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { installRelayDevTunnelListener } from '../relay-dev-tunnel.ts';

describe('relay dev-tunnel preload handoff', () => {
  it('accepts only same-window, same-origin connect events carrying a port', () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const target = {
      location: { origin: 'notnative-ui://app' },
      addEventListener: (_name: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
      removeEventListener: (_name: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
    } as unknown as Window;
    const port = { postMessage: vi.fn(), close: vi.fn() };
    const onConnect = vi.fn();
    const remove = installRelayDevTunnelListener({ target, onConnect });
    const dispatch = (source: unknown, origin: string, data: unknown, ports: unknown[] = [port]) => {
      const event = { source, origin, data, ports } as unknown as MessageEvent;
      for (const listener of listeners) listener(event);
    };
    dispatch({}, 'notnative-ui://app', { channel: 'notnative:relay-dev-tunnel', payload: { type: 'connect', connectionId: 'c1', remotePort: 3000 } });
    dispatch(target, 'https://remote.example', { channel: 'notnative:relay-dev-tunnel', payload: { type: 'connect', connectionId: 'c1', remotePort: 3000 } });
    dispatch(target, 'notnative-ui://app', { channel: 'notnative:relay-dev-tunnel', payload: { type: 'connect', connectionId: 'c1', remotePort: 3000 } }, []);
    dispatch(target, 'notnative-ui://app', { channel: 'notnative:relay-dev-tunnel', payload: { type: 'connect', connectionId: '', remotePort: 3000 } });
    dispatch(target, 'notnative-ui://app', { channel: 'notnative:relay-dev-tunnel', payload: { type: 'connect', connectionId: 'c2', remotePort: 65536 } });
    dispatch(target, 'notnative-ui://app', { channel: 'notnative:relay-dev-tunnel', payload: { type: 'connect', connectionId: 'c1', remotePort: 3000 } });
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onConnect).toHaveBeenCalledWith({ connectionId: 'c1', remotePort: 3000, bridgePort: port });
    remove();
    expect(listeners.size).toBe(0);
  });
});
