// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { walkthroughModelSelection, walkthroughReadiness } from '../model-readiness.ts';
import type { ProviderRecord } from '../../small-model/provider-ports.ts';

const provider: ProviderRecord = {
  id: 'primary', models: {
    compact: { id: 'compact', name: 'Compact', limit: { context: 100_000, input: 100_000, output: 8_000 },
      capabilities: { output: { json: true } } },
    plain: { id: 'plain', name: 'Plain', limit: { input: 1_000 },
      capabilities: { output: { json: false } } },
    mismatch: { id: 'wrong', limit: { input: 8_000 } },
    unknown: { id: 'unknown' },
  },
};
const options = { providers: [provider], credentials: { primary: 'api' } } as const;
const selection = walkthroughModelSelection({
  ...options, requestModel: 'primary/compact', settingsOverride: '', config: {},
});

describe('walkthrough model readiness', () => {
  it('normalizes explicit models but keeps tri-state catalog limits and output support', () => {
    expect(selection.model).toEqual({
      providerID: 'primary', modelID: 'compact', label: 'Compact (compact)', hasLogin: true,
      structuredOutput: true, inputCharBudget: 368_000, contextTokens: 100_000,
      contextKnown: true, outputTokens: 8_000,
    });
    expect(selection.options.map((option) => [option.providerID, option.modelID]))
      .toEqual([['primary', 'compact'], ['primary', 'plain'], ['primary', 'unknown']]);
  });

  it('prefers the request and reports empty, generated-only, and model refusals', () => {
    expect(walkthroughReadiness({ digestCount: 0, fileCount: 2, requiredChars: 8192,
      selection })).toEqual({ ready: false, reason: 'only-generated', requiredChars: 8192, availableChars: null });
    expect(walkthroughReadiness({ digestCount: 0, fileCount: 0, requiredChars: 8192,
      selection })).toEqual({ ready: false, reason: 'empty-diff', requiredChars: 8192, availableChars: null });
    expect(walkthroughReadiness({ digestCount: 1, fileCount: 1, requiredChars: 400_001,
      selection })).toEqual({ ready: false, reason: 'nnd_provider_unsupported', requiredChars: 400_001, availableChars: 368_000 });
    const supportedSelection = walkthroughModelSelection({ ...options,
      providers: [{ ...provider, id: 'openai' }], credentials: { openai: 'api' },
      requestModel: 'openai/compact', settingsOverride: '', config: {},
    });
    expect(walkthroughReadiness({ digestCount: 1, fileCount: 1, requiredChars: 400_001,
      selection: supportedSelection })).toEqual({ ready: false, reason: 'nnd_context_too_small', requiredChars: 400_001, availableChars: 368_000 });
    expect(walkthroughReadiness({ digestCount: 1, fileCount: 1, requiredChars: 368_000,
      selection: supportedSelection })).toEqual({ ready: true, reason: null, requiredChars: 368_000, availableChars: 368_000 });
    expect(walkthroughReadiness({ digestCount: 1, fileCount: 1, requiredChars: 8192,
      selection: walkthroughModelSelection({ ...options, requestModel: 'primary/missing',
        settingsOverride: '', config: {} }) })).toEqual({ ready: false, reason: 'no-model',
      requiredChars: 8192, availableChars: null });
    expect(walkthroughReadiness({ digestCount: 1, fileCount: 1, requiredChars: 8192,
      selection: walkthroughModelSelection({ ...options, credentials: {}, requestModel: 'primary/compact',
        settingsOverride: '', config: {} }) })).toEqual({ ready: false, reason: 'no-provider-login',
      requiredChars: 8192, availableChars: 368_000 });
  });

  it('falls back to an authenticated supported catalog family only when the small-model chain is enabled', () => {
    const provider: ProviderRecord = { id: 'openai', options: { apiKey: 'test-key' }, models: {
      'gpt-nano': { id: 'gpt-nano', limit: { context: 100_000, output: 8_000 },
        capabilities: { output: { json: true } } },
    } };
    const defaultSelection = walkthroughModelSelection({ providers: [provider], credentials: { openai: 'api' },
      requestModel: null, settingsOverride: '', config: {}, smallModelSettings: { smallModelUseDefault: true } });
    expect(defaultSelection.selected).toEqual({ providerID: 'openai', modelID: 'gpt-nano' });
    const restricted = walkthroughModelSelection({ providers: [provider], credentials: { openai: 'api' },
      requestModel: null, settingsOverride: '', config: {},
      smallModelSettings: { smallModelUseDefault: false, smallModelOverride: 'openai/missing' } });
    expect(restricted.model).toBeNull();
  });
});
