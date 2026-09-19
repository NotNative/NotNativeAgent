// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4a gates part 2 (file B): the §2.7 device authority matrix (plain
 * tokens self-only; desktop-local/session manage; pairing-reading is
 * manage-surface only after the review P1), the §3.13 candidates refresh
 * + transports view (never URL-token-authorized), and the password-mode
 * posture rows.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clientAuthHarness } from './helpers/client-auth-harness.ts';
import { getRelayHostService } from '../lib/relay/host-service.ts';
import { getPairingSessionStore } from '../lib/auth/pairing-sessions.ts';
import { getUiAuthController } from '../lib/auth/ui-auth.ts';
import { serverLabel } from '../lib/auth/pairing-candidates.ts';

const h = clientAuthHarness();
const RELAY_WS = 'wss://relay.openchamber.dev/ws';

afterAll(() => {
  h.dispose();
});

beforeEach(() => {
  delete process.env.NOTNATIVE_UI_PASSWORD;
  h.resetPairingSlate();
});

describe('client device routes (§2.7 authority matrix)', () => {
  it('open mode manages freely: create/list/revoke/purge', async () => {
    await h.drainClients();
    const mint = await h.mintViaRoute('Tablet', 'mobile');
    expect(mint.token).toMatch(/^oc_client_/u);
    const list = (await (await h.call('/api/client-auth/clients')).json()) as { clients: Array<Record<string, unknown>> };
    expect(list.clients.map((row) => row['label'])).toContain('Tablet');
    const revoked = await h.call(`/api/client-auth/clients/${mint.clientId}`, { method: 'DELETE' });
    expect(((await revoked.json()) as { revoked: boolean }).revoked).toBe(true);
    const purge = await h.call('/api/client-auth/clients', { method: 'DELETE' });
    expect(((await purge.json()) as { purged: number }).purged).toBe(1);
  });

  it('plain tokens see only themselves, may only revoke themselves, cannot create or purge', async () => {
    await h.drainClients(); // deterministic slate: earlier tests legitimately left device records
    const own = await h.mintViaRoute('Pixel', 'mobile');
    const shell = await h.mintViaRoute('Shell', 'desktop-local');
    const seen = (await (await h.bearer('/api/client-auth/clients', own.token)).json()) as { clients: Array<{ id: string }> };
    expect(seen.clients.map((row) => row.id)).toEqual([own.clientId]);
    const shellList = (await (await h.bearer('/api/client-auth/clients', shell.token)).json()) as { clients: unknown[] };
    expect(shellList.clients.length).toBe(2);
    const blockedCreate = await h.bearer('/api/client-auth/clients', own.token, 'POST', { label: 'Nope' });
    expect(blockedCreate.status).toBe(403);
    expect(((await blockedCreate.json()) as Record<string, unknown>)['error']).toBe('Client tokens cannot create remote clients');
    const blockedSelf = await h.bearer(`/api/client-auth/clients/${shell.clientId}`, own.token, 'DELETE');
    expect(blockedSelf.status).toBe(403);
    expect(((await blockedSelf.json()) as Record<string, unknown>)['error']).toBe('Client tokens can only revoke themselves');
    const missing = await h.bearer('/api/client-auth/clients/dev_unknown', own.token, 'DELETE');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as Record<string, unknown>)['error']).toBe('Client not found');
    const blockedPurge = await h.bearer('/api/client-auth/clients', own.token, 'DELETE');
    expect(blockedPurge.status).toBe(403);
    const selfRevoke = await h.bearer(`/api/client-auth/clients/${own.clientId}`, own.token, 'DELETE');
    expect(selfRevoke.status).toBe(200);
    const shellRevoke = await h.bearer(`/api/client-auth/clients/${shell.clientId}`, shell.token, 'DELETE');
    expect(shellRevoke.status).toBe(200);
    const purge = await h.call('/api/client-auth/clients', { method: 'DELETE' });
    expect(((await purge.json()) as { purged: number }).purged).toBe(2);
  });

  it('pairing surface reads are manage-authority: a plain token is 403 on pending list + transports', async () => {
    const own = await h.mintViaRoute('Snooper', 'mobile');
    const blockedSessions = await h.bearer('/api/client-auth/pairing/sessions', own.token);
    expect(blockedSessions.status).toBe(403);
    expect(((await blockedSessions.json()) as Record<string, unknown>)['error']).toBe('Client tokens cannot read the pairing surface');
    const blockedTransports = await h.bearer('/api/client-auth/pairing/transports', own.token);
    expect(blockedTransports.status).toBe(403);
    // the §3.13 candidates refresh stays bearer-wide (rides relay/direct transports)
    const refresh = await h.bearer('/api/client-auth/connection/candidates', own.token);
    expect(refresh.status).toBe(200);
  });

  it('revoking the last relay-paired device turns the relay host off (§3.12 reconcile)', async () => {
    await h.drainClients(); // the redeem describe intentionally left a relay-paired device behind
    const kitLocal = h.seedService('real');
    const mint = await h.mintViaRoute('RelayTab', 'mobile');
    const clientRecord = getUiAuthController().getClientStore().listClients().find((row) => row.id === mint.clientId);
    clientRecord!.usesRelay = true;
    await getRelayHostService().reconcile();
    expect(h.configEnabled()).toBe(true);
    expect(kitLocal.hosts.length).toBe(1);
    const revoked = await h.call(`/api/client-auth/clients/${mint.clientId}`, { method: 'DELETE' });
    expect(((await revoked.json()) as { revoked: boolean }).revoked).toBe(true);
    await h.waitUntil(() => h.configEnabled() === false && kitLocal.hosts[0]!.stopped >= 1);
    expect(kitLocal.hosts[0]!.stopped).toBe(1);
  });
});

describe('connection/candidates + transports (§3.13)', () => {
  it('the client-reached address leads, interface scan follows, serverId rides the payload', async () => {
    h.seedService('false');
    const response = await h.call('/api/client-auth/connection/candidates', {
      socket: { remoteAddress: '192.168.1.50', localAddress: '192.168.1.5', localPort: 3902 },
    });
    const body = (await response.json()) as { label: string; serverId?: string; candidates: Array<{ type: string; url: string; priority?: number }> };
    expect(body.label).toBe(serverLabel());
    expect(typeof body.serverId).toBe('string');
    expect(body.candidates[0]).toEqual({ type: 'lan', url: 'http://192.168.1.5:3902', priority: 10 });
    expect(body.candidates.some((row) => row.url === 'http://127.0.0.1:3902')).toBe(false);
  });

  it('loopback reached-addresses are dropped; scan candidates (when any) are lan rows', async () => {
    h.seedService('false');
    const body = (await (await h.call('/api/client-auth/connection/candidates', {
      socket: { remoteAddress: '192.168.1.50', localAddress: '127.0.0.1', localPort: 3902 },
    })).json()) as { candidates: Array<{ type: string; url: string }> };
    expect(body.candidates.some((row) => row.url === 'http://127.0.0.1:3902')).toBe(false);
    expect(body.candidates.every((row) => row.type === 'lan')).toBe(true);
  });

  it('the relay candidate rides last (priority 30) once the host is enabled', async () => {
    h.seedService('real');
    getPairingSessionStore().createPairingSession({ usesRelay: true });
    await getRelayHostService().reconcile();
    const body = (await (await h.call('/api/client-auth/connection/candidates', {
      socket: { remoteAddress: '192.168.1.50', localAddress: '192.168.1.5', localPort: 3902 },
    })).json()) as { candidates: Array<Record<string, unknown>> };
    const last = body.candidates[body.candidates.length - 1]!;
    expect(last['type']).toBe('relay');
    expect(last['priority']).toBe(30);
    expect(last['serverId']).toBe('srv-test');
    expect(last['relayUrl']).toBe(RELAY_WS);
  });

  it('transports view derives LAN from the bind (loopback -> null) and reports relay availability', async () => {
    h.seedService('real'); // real signals; the first half runs before any demand exists
    const before = (await (await h.call('/api/client-auth/pairing/transports')).json()) as { local: string; lan: string | null; relayAvailable: boolean };
    expect(before.local).toBe('http://127.0.0.1:3902');
    expect(before.lan).toBeNull();
    expect(before.relayAvailable).toBe(false);
    getPairingSessionStore().createPairingSession({ usesRelay: true });
    await getRelayHostService().reconcile();
    const after = (await (await h.call('/api/client-auth/pairing/transports')).json()) as { relayAvailable: boolean };
    expect(after.relayAvailable).toBe(true);
  });
});

describe('password-mode posture of the client-auth family', () => {
  it('gated rows 401 without a session and the redeem stays anonymous', async () => {
    h.seedService('false');
    const session = getPairingSessionStore().createPairingSession({});
    process.env.NOTNATIVE_UI_PASSWORD = 'pw';
    const unauthList = await h.call('/api/client-auth/clients');
    expect(unauthList.status).toBe(401);
    const unauthSessions = await h.call('/api/client-auth/pairing/sessions');
    expect(unauthSessions.status).toBe(401);
    const login = await h.call('/auth/session', { method: 'POST', body: { password: 'pw' }, socket: { remoteAddress: '127.0.0.1' } });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();
    expect((await h.call('/api/client-auth/pairing/sessions', { cookie })).status).toBe(200);
    const redeem = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: session.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.200' },
    });
    expect(redeem.status).toBe(400); // anonymous regardless of the ui password
    delete process.env.NOTNATIVE_UI_PASSWORD;
  });

  it('connection/candidates is NEVER URL-token-authorized; session cookie passes', async () => {
    h.seedService('false');
    process.env.NOTNATIVE_UI_PASSWORD = 'pw';
    const login = await h.call('/auth/session', { method: 'POST', body: { password: 'pw' }, socket: { remoteAddress: '127.0.0.1' } });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const mintedToken = (await (await h.call('/auth/url-token', { method: 'POST', cookie })).json()) as { token: string };
    expect(mintedToken.token).toMatch(/^oc_url_/u);
    const rejected = await h.call('/api/client-auth/connection/candidates?oc_url_token=' + encodeURIComponent(mintedToken.token));
    expect(rejected.status).toBe(401);
    const withCookie = await h.call('/api/client-auth/connection/candidates', { cookie });
    expect(withCookie.status).toBe(200);
    delete process.env.NOTNATIVE_UI_PASSWORD;
  });
});
