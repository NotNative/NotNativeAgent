import { describe, expect, it, vi } from 'vitest';

vi.mock('../runtime-url.ts', () => ({ configureRuntimeUrlResolver: vi.fn() }));
vi.mock('../runtime-auth.ts', () => ({
  clearCachedUrlAuthToken: vi.fn(),
  setRuntimeBearerToken: vi.fn(),
  setRuntimeExtraHeaders: vi.fn(),
  refreshRuntimeUrlAuthToken: vi.fn(async () => undefined),
}));
import { clearCachedUrlAuthToken } from '../runtime-auth.ts';
vi.mock('../runtime-tunnel.ts', () => ({
  activateRelayTunnel: vi.fn(),
  deactivateRelayTunnel: vi.fn(),
}));
import {
  DEFAULT_RUNTIME_KEY,
  MOBILE_DISCONNECTED_RUNTIME_KEY,
  deriveRuntimeKey,
  getRuntimeKey,
  isTransientRuntimeKey,
  onRuntimeEndpointChanged,
  switchRuntimeEndpoint,
} from '../runtime-switch.ts';

describe('runtime keys (doc 01 §11)', () => {
  it('derives url-origin keys outside desktop shells', () => {
    expect(deriveRuntimeKey('https://lab.example:3000/')).toBe('url:https://lab.example:3000');
    expect(deriveRuntimeKey('garbage')).toBe(DEFAULT_RUNTIME_KEY);
  });

  it('flags transient keys as forbidden persistence namespaces', () => {
    expect(isTransientRuntimeKey(DEFAULT_RUNTIME_KEY)).toBe(true);
    expect(isTransientRuntimeKey(MOBILE_DISCONNECTED_RUNTIME_KEY)).toBe(true);
    expect(isTransientRuntimeKey('')).toBe(true);
    expect(isTransientRuntimeKey(null)).toBe(true);
    expect(isTransientRuntimeKey('local')).toBe(false);
    expect(isTransientRuntimeKey('host:abc')).toBe(false);
  });

  it('notifies every subscribed runtime consumer after the new endpoint is active', async () => {
    const previousInvalidations = vi.mocked(clearCachedUrlAuthToken).mock.calls.length;
    const first = vi.fn(() => { throw new Error('subscriber failed'); });
    const second = vi.fn(() => getRuntimeKey());
    const offFirst = onRuntimeEndpointChanged(first);
    const offSecond = onRuntimeEndpointChanged(second);
    try {
      await switchRuntimeEndpoint({ apiBaseUrl: 'https://lab.example:3000/', runtimeKey: 'host:lab' });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(second).toHaveReturnedWith('host:lab');
      expect(second).toHaveBeenCalledWith(expect.objectContaining({
        apiBaseUrl: 'https://lab.example:3000',
        runtimeKey: 'host:lab',
      }));
      offSecond();
      await switchRuntimeEndpoint({ apiBaseUrl: 'https://other.example/', runtimeKey: 'host:other' });
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledTimes(2);
      expect(vi.mocked(clearCachedUrlAuthToken).mock.calls.length - previousInvalidations).toBe(2);
    } finally {
      offFirst();
      offSecond();
    }
  });

  it('resets subscribers before a changed event can unmount them', async () => {
    const seen: string[] = [];
    const off = onRuntimeEndpointChanged(() => { seen.push('store reset'); });
    vi.stubGlobal('CustomEvent', class {
      constructor(public readonly type: string, public readonly init: { detail: unknown }) {}
    });
    vi.stubGlobal('window', {
      dispatchEvent: (event: { type: string }) => {
        if (event.type === 'notnative:runtime-endpoint-changed') {
          seen.push('view update');
          off();
        }
      },
    });
    try {
      await switchRuntimeEndpoint({ apiBaseUrl: 'https://lab.example/', runtimeKey: 'host:lab' });
      expect(seen).toEqual(['store reset', 'view update']);
    } finally {
      off();
      vi.unstubAllGlobals();
    }
  });
});
