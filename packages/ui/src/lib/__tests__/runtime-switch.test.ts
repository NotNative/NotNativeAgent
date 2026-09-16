import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_KEY,
  MOBILE_DISCONNECTED_RUNTIME_KEY,
  deriveRuntimeKey,
  isTransientRuntimeKey,
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
});
