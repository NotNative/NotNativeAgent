// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { NativeProviderObservationFailure, parseNativeProviderObservationView }
  from '../provider-observation.ts';

const capabilities = { streaming: true, tools: false, images: true, structured_output: false,
  usage: true, cancellation: false };
const secretEntry = { id: 'remote', model: 'remote-model', endpoint: 'https://models.example.test/v1',
  trust_zone: 'public_network',
  credential: { source: 'secret', secret_id: 'sec_provider', field: 'api_key' },
  credential_env: null, capabilities };
const environmentEntry = { id: 'local', model: 'local-model', endpoint: 'http://127.0.0.1:1234/v1',
  trust_zone: 'loopback', credential: { source: 'environment', name: 'LOCAL_PROVIDER_TOKEN' },
  credential_env: 'LOCAL_PROVIDER_TOKEN', capabilities };
const unboundEntry = { id: 'none', model: 'm', endpoint: 'http://127.0.0.1:9/v1',
  trust_zone: 'loopback', credential: null, credential_env: null, capabilities };
const view = (providers: unknown[], revision = 'a'.repeat(64)) => ({ schema_version: '1.0',
  installation_id: 'nna_1', data_id: 'data_1', scope: 'user',
  source_state: providers.length ? 'present' : 'absent', manifest_revision: revision, providers });

describe('native provider observation parser', () => {
  it('accepts the binding grammar NNA serves and refuses anything that could carry a value', () => {
    const read = parseNativeProviderObservationView(view([secretEntry, environmentEntry, unboundEntry]));
    expect(read.providers).toHaveLength(3);
    // The wire form is snake_case, as credentialManifest emits it; the camelCase
    // internal shape must never reach the desktop.
    expect(read.providers[0]!.credential).toEqual({ source: 'secret', secret_id: 'sec_provider',
      field: 'api_key' });
    expect(read.providers[1]!.credential).toEqual({ source: 'environment',
      name: 'LOCAL_PROVIDER_TOKEN' });
    expect(read.providers[1]!.credential_env).toBe('LOCAL_PROVIDER_TOKEN');
    expect(read.providers[2]!.credential).toBeNull();
    expect(read.providers[0]!.capabilities.streaming).toBe(true);

    const absent = parseNativeProviderObservationView(view([], 'absent'));
    expect(absent.source_state).toBe('absent');
    expect(absent.providers).toEqual([]);

    for (const drift of [
      // A binding that could hold a value is the one refusal that matters here.
      view([{ ...secretEntry, credential: { ...secretEntry.credential, value: 'sk-live' } }]),
      // camelCase is the engine shape, not the wire shape.
      view([{ ...secretEntry, credential: { source: 'secret', secretId: 'sec_provider',
        field: 'api_key' } }]),
      // An unknown source is not a binding this surface knows how to redact.
      view([{ ...secretEntry, credential: { source: 'vault', secret_id: 'sec_provider',
        field: 'api_key', token: 'x' } }]),
      view([{ ...secretEntry, credential: null, credential_env: 7 }]),
      view([{ ...secretEntry, trust_zone: 'private' }]),
      view([{ ...secretEntry, capabilities: { ...capabilities, unexpected: true } }]),
      view([{ ...secretEntry, capabilities: { ...capabilities, tools: 'yes' } }]),
      view([{ ...secretEntry, unexpected: true }]),
      view([secretEntry], 'not-a-revision'),
      { ...view([secretEntry]), unexpected: true },
      { ...view([]), source_state: 'present' },
    ]) {
      expect(() => parseNativeProviderObservationView(drift)).toThrow(NativeProviderObservationFailure);
    }
  });
});
