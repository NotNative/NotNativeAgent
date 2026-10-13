// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { probeDesktopRelayHost } from '../desktop-relay-host.ts';
import type { RelayTunnelClient } from '../relay/tunnel-client-types.ts';

const relay = {
  relayUrl: 'wss://relay.example/ws', serverId: 'server-1',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
};
function makeClient(responses: Response[]): RelayTunnelClient & { close: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 })),
    close: vi.fn(), getStatus: () => ({ state: 'connected' }), subscribeStatus: () => () => undefined,
    openWebSocket: vi.fn() as never,
  };
}

describe('probeDesktopRelayHost', () => {
  it('checks identity, API compatibility, and auth before returning a live probe tunnel', async () => {
    const client = makeClient([
      Response.json({ serverId: 'server-1' }),
      Response.json({ status: 'ok', compatibility: { capabilities: ['api.runtime-url.v1'], apiVersion: 1, minClientApiVersion: 1 } }),
      Response.json({ ok: true }),
    ]);
    const result = await probeDesktopRelayHost(relay, { keepTunnel: true, clientToken: 'token', createClient: () => client });
    expect(result.status).toBe('ok');
    expect(result.client).toBe(client);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.fetch.mock.calls.map(([url]) => url)).toEqual(['/health', '/api/version', '/auth/session']);
    expect(client.fetch.mock.calls[1]?.[1]?.headers).toBeInstanceOf(Headers);
    expect(new Headers(client.fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer token');
  });

  it('rejects a relay tunnel connected to a different server and closes it', async () => {
    const client = makeClient([Response.json({ serverId: 'other-server' })]);
    const result = await probeDesktopRelayHost(relay, { keepTunnel: true, createClient: () => client });
    expect(result.status).toBe('wrong-service');
    expect(result.client).toBeUndefined();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
