// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../runtime-fetch.ts';
import { parseNativeConfigurationView, requestNativeConfiguration } from '../configuration.ts';
vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

const fixture = {
  schema_version: '1.0', installation_id: 'nna_123', data_id: 'data_456', scope: 'user',
  source_state: 'present', source_revision: 'absent', resolution_revision: 'a'.repeat(64),
  source_revisions: [{ source: 'user', revision: 'absent' }, { source: 'unknown', revision: 'b'.repeat(64) }],
  application: 'not_applied', fields: [
    { path: 'provider.api_key_env', catalog_path: 'provider.api_key_env', explicit: { present: true, redacted: true },
      effective: { present: true, redacted: true, source: 'user' }, application: 'not_applied' },
    { path: 'streaming', catalog_path: 'streaming', explicit: { present: false },
      effective: { present: true, value: true, source: 'compiled_default' }, application: 'not_applied' },
  ],
};
it('accepts native workspace source projection and preserves redaction and effective defaults', async () => {
  vi.mocked(runtimeFetch).mockResolvedValue(new Response(JSON.stringify(fixture)));
  const result = await requestNativeConfiguration(new AbortController().signal);
  expect(runtimeFetch).toHaveBeenCalledWith('/api/v1/nnd/configuration', expect.objectContaining({ method: 'GET' }));
  expect(result.fields[0]!.explicit).toEqual({ present: true, redacted: true });
  expect(result.fields[1]!.effective).toEqual({ present: true, value: true, source: 'compiled_default' });
  expect(result.source_revisions[1]!.source).toBe('unknown');
});
it('rejects contradictory value and redaction rather than displaying supplied secret text', () => {
  const unsafe = structuredClone(fixture);
  (unsafe.fields[0]!.explicit as Record<string, unknown>).value = 'secret';
  expect(parseNativeConfigurationView(unsafe)).toBeNull();
});
it('rejects contradictory absent, unavailable and false redaction flags', () => {
  for (const explicit of [
    { present: false, value_unavailable: true },
    { present: true, redacted: false, value: 'secret' },
    { present: true, redacted: true, value_unavailable: true },
    { present: true, value_unavailable: false, value: 'secret' },
  ]) {
    const response = structuredClone(fixture);
    response.fields[0]!.explicit = explicit as never;
    expect(parseNativeConfigurationView(response)).toBeNull();
  }
});
it('does not accept another scope or unchecked application state', () => {
  expect(parseNativeConfigurationView({ ...fixture, scope: 'project' })).toBeNull();
  expect(parseNativeConfigurationView({ ...fixture, application: 'applied' })).toBeNull();
});
it('distinguishes an unsupported native endpoint from a missing configuration source', async () => {
  vi.mocked(runtimeFetch).mockResolvedValue(new Response('', { status: 404 }));
  await expect(requestNativeConfiguration(new AbortController().signal)).rejects.toThrow('native-configuration-unsupported');
  expect(parseNativeConfigurationView({ ...fixture, source_state: 'missing' })?.source_state).toBe('missing');
});
