// SPDX-License-Identifier: Apache-2.0
import { runtimeFetch } from '../runtime-fetch.ts';

export interface NativeSetupStatus {
  service_state: 'setup_required' | 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';
  configuration_state: 'unverified' | 'invalid' | 'ready';
  execution_state: 'unavailable' | 'ready';
  provider_state: 'unknown';
  failure_code: string | null;
}
export function parseNativeSetupStatus(value: unknown): NativeSetupStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const s = value as NativeSetupStatus;
  if (!['setup_required','starting','ready','failed','stopping','stopped'].includes(s.service_state)
    || !['unverified','invalid','ready'].includes(s.configuration_state)
    || !['unavailable','ready'].includes(s.execution_state) || s.provider_state !== 'unknown'
    || !(s.failure_code === null || typeof s.failure_code === 'string' && /^nnd_[a-z_]{1,80}$/u.test(s.failure_code))) return null;
  if (s.execution_state === 'ready' && (s.configuration_state !== 'ready' || s.service_state !== 'ready')) return null;
  if (s.service_state === 'ready' && s.execution_state !== 'ready') return null;
  return { service_state: s.service_state, configuration_state: s.configuration_state,
    execution_state: s.execution_state, provider_state: s.provider_state, failure_code: s.failure_code };
}
export async function requestNativeSetup(activate: boolean, signal: AbortSignal): Promise<{
  status: NativeSetupStatus | null; error: boolean;
}> {
  const response = await runtimeFetch(`/api/v1/nnd/setup/${activate ? 'activate' : 'status'}`, {
    method: activate ? 'POST' : 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(activate ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('native-setup-unavailable');
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw new Error('native-setup-invalid'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const status = parseNativeSetupStatus(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)));
  return { status: response.ok || activate && response.status === 503 ? status : null, error: !response.ok || status === null };
}
