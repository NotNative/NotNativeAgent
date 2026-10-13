// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { NativeLegacyCredentialsFailure, parseNativeLegacyProviderCredentials } from '../legacy-credentials.ts';

const receipt = (overrides: Record<string, unknown> = {}) => ({
  schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1', scope: 'user',
  loaded: true, count: 1, reason: null, ...overrides });

describe('native legacy provider-credentials parser', () => {
  it('accepts the verdict grammar and refuses drift', () => {
    const parsed = parseNativeLegacyProviderCredentials(receipt());
    expect(parsed.loaded).toBe(true);
    expect(parsed.count).toBe(1);
    const absent = parseNativeLegacyProviderCredentials(receipt({ loaded: false, count: 0 }));
    expect(absent.loaded).toBe(false);
    const refused = parseNativeLegacyProviderCredentials(receipt({
      loaded: false, count: 0, reason: 'provider_credentials_invalid' }));
    expect(refused.reason).toBe('provider_credentials_invalid');
    for (const drift of [
      receipt({ loaded: 'true' }),
      receipt({ count: 2 }),
      receipt({ reason: 'mystery' }),
      receipt({ extra: true }),
      receipt({ loaded: false }),
      receipt({ loaded: false, count: 0, reason: 'nnd_made_up' }),
      receipt({ scope: 'workspace' }),
    ]) {
      expect(() => parseNativeLegacyProviderCredentials(drift)).toThrow(NativeLegacyCredentialsFailure);
    }
  });
});
