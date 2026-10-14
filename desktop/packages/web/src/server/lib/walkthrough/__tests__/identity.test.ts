// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { configuredIdentity, identityFromString, providerModels, sessionIdentity,
  seniorAssistantIdentity, walkthroughCacheKey } from '../identity.ts';

const stop = { id: 'working:a.ts:12345678', scope: 'working' as const, path: 'a.ts',
  header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, body: '-old\nnew' };
const snapshot = { signature: 'signature', stops: [stop], fileCount: 1, binaryFiles: 0 };

describe('walkthrough model identity', () => {
  it('prefers a bounded direct session model over unsigned session metadata', () => {
    expect(sessionIdentity({ providerID: 'nna', modelID: 'build', walkthroughModelID: { providerID: 'x', modelID: 'wrong' } }))
      .toEqual({ providerID: 'nna', modelID: 'build' });
    expect(sessionIdentity({ model: { providerID: 'nna', id: 'session-model' }, subjectModelID: { providerID: 'x', modelID: 'wrong' } }))
      .toEqual({ providerID: 'nna', modelID: 'session-model' });
    expect(sessionIdentity({ walkthroughModelID: { providerID: 'x', modelID: 'inherited' } }))
      .toEqual({ providerID: 'x', modelID: 'inherited' });
    expect(sessionIdentity({ modelID: '' })).toBeNull();
  });

  it('uses the newest model-carrying assistant message when a session route is absent', () => {
    expect(seniorAssistantIdentity([{ info: { role: 'assistant', modelID: 'old-model', providerID: 'old' } },
      { info: { role: 'user', modelID: 'wrong', providerID: 'wrong' } }]))
      .toEqual({ providerID: 'old', modelID: 'old-model' });
    expect(seniorAssistantIdentity([{ info: { role: 'assistant', modelID: '', providerID: 'old' } }])).toBeNull();
  });

  it('accepts only explicit provider/model strings and provider inventory model rows', () => {
    expect(identityFromString('openai/gpt-nano/legacy/default')).toEqual({ providerID: 'openai', modelID: 'gpt-nano/legacy/default' });
    expect(identityFromString('openai')).toBeNull();
    const provider = { id: 'openai', models: { 'gpt-nano': { id: 'gpt-nano' }, hidden: { id: 'other' } } };
    expect(providerModels(provider)).toEqual([{ providerID: 'openai', modelID: 'gpt-nano' },
      { providerID: 'openai', modelID: 'other' }]);
    // Uniformity #2: the dead config reads (small_model / walkthrough_model)
    // are gone — the chain honors override, per-call choice, then NNA's model.
    expect(configuredIdentity({ small_model: 'openai/gpt-nano' }, [provider], '', '')).toBeNull();
    expect(configuredIdentity({}, [provider], 'openai/gpt-nano', '')).toEqual({
      providerID: 'openai', modelID: 'gpt-nano' });
    expect(configuredIdentity({ model: 'openai/gpt-nano' }, [provider], '', '')).toEqual({
      providerID: 'openai', modelID: 'gpt-nano' });
    expect(configuredIdentity({}, [provider], 'openai/missing', '')).toBeNull();
  });

  it('separates cache identity by walkthrough revision, source, model, language, and files', () => {
    const identity = { providerID: 'openai', modelID: 'gpt-nano' };
    const first = walkthroughCacheKey('v1', '/repo', 'working-tree:all', identity, 'en', snapshot);
    const second = walkthroughCacheKey('v1', '/repo', 'working-tree:staged', identity, 'en', snapshot);
    const otherLanguage = walkthroughCacheKey('v1', '/repo', 'working-tree:all', identity, 'uk', snapshot);
    const otherModel = walkthroughCacheKey('v1', '/repo', 'working-tree:all',
      { providerID: 'openai', modelID: 'gpt-latest' }, 'en', snapshot);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    const otherRevision = walkthroughCacheKey('v1', '/repo', 'working-tree:all', identity, 'en',
      { ...snapshot, signature: 'different-signature' });
    expect(new Set([first, second, otherLanguage, otherModel]).size).toBe(4);
    expect(otherRevision).not.toBe(first);
  });
});
