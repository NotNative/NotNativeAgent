import { describe, expect, it } from 'vitest';
import { shouldCoalesce } from '../runtime-fetch.ts';

describe('shouldCoalesce (HP-6)', () => {
  it('coalesces allowlisted GETs', () => {
    for (const path of [
      '/api/config',
      '/api/path',
      '/api/app/agents',
      '/api/agent',
      '/api/project',
      '/api/command',
    ]) {
      expect(shouldCoalesce(path, 'GET')).toBe(true);
    }
  });

  it('never coalesces other traffic', () => {
    expect(shouldCoalesce('/api/session', 'GET')).toBe(false);
    expect(shouldCoalesce('/api/config', 'POST')).toBe(false);
    expect(shouldCoalesce('/api/event', 'GET')).toBe(false);
    expect(shouldCoalesce('https://x.example/api/config?with=query', 'GET')).toBe(true);
  });

  it('excludes signal callers and Request inputs', () => {
    expect(shouldCoalesce('/api/config', 'GET', undefined, true)).toBe(false);
    expect(shouldCoalesce('/api/config', 'GET', { signal: {} as never })).toBe(false);
  });
});
