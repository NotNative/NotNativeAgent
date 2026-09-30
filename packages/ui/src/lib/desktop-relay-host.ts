// SPDX-License-Identifier: Apache-2.0
import { createRelayTunnelClient } from './relay/tunnel-client.ts';
import type { RelayTunnelClient } from './relay/tunnel-client-types.ts';
import type { RelayDescriptor } from './runtime-tunnel.ts';

const DEADLINE_MS = 15_000;
const MAX_JSON_BYTES = 64 * 1024;
const REQUIRED_CAPABILITY = 'api.runtime-url.v1';

export type RelayHostProbeStatus = 'ok' | 'auth' | 'incompatible' | 'update-recommended' | 'wrong-service' | 'unreachable';
export interface RelayHostProbeResult { status: RelayHostProbeStatus; latencyMs: number; client?: RelayTunnelClient }
export type RelayHostClientFactory = (relay: RelayDescriptor) => RelayTunnelClient;

async function readJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new Error('too-large');
  if (!response.body) throw new Error('invalid-json');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new Error('too-large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Validate a persisted relay host through its encrypted tunnel. A successful
 * keepTunnel probe returns the connected client for zero-handshake adoption. */
export async function probeDesktopRelayHost(
  relay: RelayDescriptor,
  options: { clientToken?: string | null; requestHeaders?: Record<string, string>; keepTunnel?: boolean; createClient?: RelayHostClientFactory } = {},
): Promise<RelayHostProbeResult> {
  const started = Date.now();
  const client = (options.createClient ?? ((descriptor) => createRelayTunnelClient({
    ...descriptor, platform: 'desktop',
  })))(relay);
  const controller = new AbortController();
  let unsubscribe: (() => void) | undefined;
  const terminal = new Promise<RelayHostProbeStatus>((resolve) => {
    unsubscribe = client.subscribeStatus((status) => {
      if (status.state === 'error') resolve('unreachable');
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let succeeded = false;
  const deadline = new Promise<RelayHostProbeStatus>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve('unreachable'); }, DEADLINE_MS);
  });
  const work = (async (): Promise<RelayHostProbeStatus> => {
    const request = async (path: string, authenticated: boolean): Promise<Response> => {
      const headers = new Headers({ accept: 'application/json' });
      if (authenticated) {
        for (const [key, value] of Object.entries(options.requestHeaders ?? {})) {
          if (/^[A-Za-z0-9-]{1,64}$/u.test(key) && typeof value === 'string'
            && !/^(authorization|cookie|set-cookie)$/iu.test(key)) headers.set(key, value);
        }
        if (options.clientToken) headers.set('authorization', `Bearer ${options.clientToken}`);
      }
      return client.fetch(path, { headers, signal: controller.signal });
    };
    try {
      const health = await request('/health', false);
      if (health.status >= 300 && health.status < 400 || health.redirected) return 'wrong-service';
      if (health.ok) {
        let identity: unknown;
        try { identity = await readJson(health); } catch { return 'wrong-service'; }
        if (typeof identity !== 'object' || identity === null || (identity as { serverId?: unknown }).serverId !== relay.serverId) return 'wrong-service';
      }
      const versionResponse = await request('/api/version', true);
      if (versionResponse.status === 401 || versionResponse.status === 403) return 'auth';
      if (!versionResponse.ok) return 'unreachable';
      let version: unknown;
      try { version = await readJson(versionResponse); } catch { return 'wrong-service'; }
      if (!version || typeof version !== 'object' || (version as { status?: unknown }).status !== 'ok') return 'wrong-service';
      const compatibility = (version as { compatibility?: unknown }).compatibility;
      if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)) return 'wrong-service';
      const compat = compatibility as { capabilities?: unknown; apiVersion?: unknown; minClientApiVersion?: unknown };
      if (!Array.isArray(compat.capabilities) || !compat.capabilities.includes(REQUIRED_CAPABILITY)) return 'incompatible';
      if (compat.apiVersion !== 1 || (typeof compat.minClientApiVersion === 'number' && compat.minClientApiVersion > 1)) return 'update-recommended';
      const session = await request('/auth/session', true);
      if (session.status === 401 || session.status === 403) return 'auth';
      return session.ok ? 'ok' : 'unreachable';
    } catch { return 'unreachable'; }
  })();
  try {
    const status = await Promise.race([work, deadline, terminal]);
    if (status === 'ok' && options.keepTunnel) { succeeded = true; return { status, latencyMs: Date.now() - started, client }; }
    return { status, latencyMs: Date.now() - started };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe?.();
    controller.abort();
    if (!succeeded) client.close();
  }
}
