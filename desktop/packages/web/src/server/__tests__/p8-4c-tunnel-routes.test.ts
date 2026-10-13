// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4c gates part 6: the tunnel HTTP API (doc 03 §5.34 rows) over the
 * real app — gate posture (open-mode manage), check/provider/doctor
 * diagnostics with the CLI-parity `hasSavedManagedRemoteProfile` flag and
 * the managed-local config probe, managed-remote-token upsert +
 * token-free responses, the full §4.6/§4.7 start→connect→replace→stop
 * lifecycle end to end (bootstrap one-time exchange, tunnel-scope gating
 * with the Host classifier, replacement revocation counts), and the
 * system/info tunnelUrl view.
 */
import './helpers/env-boot.ts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clientAuthHarness } from './helpers/client-auth-harness.ts';
import {
  readTunnelSettingsDefaults,
} from '../lib/tunnels/tunnel-settings.ts';
import {
  setTunnelSpawnDepsForTests,
} from '../lib/tunnels/tunnel-spawn.ts';
import {
  getTunnelAuthController, resetTunnelAuthForTests,
} from '../lib/auth/tunnel-auth.ts';
import {
  getManagedRemoteProfileStore, resetManagedRemoteProfileStoreForTests,
} from '../lib/tunnels/tunnel-profile-store.ts';
import {
  getTunnelService, resetTunnelServiceForTests,
} from '../lib/tunnels/tunnel-service.ts';
import { TunnelServiceError } from '../lib/tunnels/tunnel-validate.ts';
import { FakeChild, controllerFor, plantBinary, fakeSpawnDeps, type FakeSpawnKit } from './helpers/tunnel-fakes.ts';

const h = clientAuthHarness();
let calls = 0;
let children: FakeChild[] = [];
let starterRequests: Array<Record<string, unknown>> = [];
let depsKit: FakeSpawnKit | null = null;

/** Per-test tunnel slate: fresh singletons + the fake starter registry.
 * First-call wins on getTunnelService — reseeding after a reset re-binds. */
function seedTunnel(faults: { throwOnRequest?: Record<string, unknown> } = {}): void {
  calls = 0;
  children = [];
  starterRequests = [];
  getTunnelAuthController();
  getManagedRemoteProfileStore({ dataDir: h.dir });
  depsKit = fakeSpawnDeps(`${h.dir}/bin`);
  plantBinary(depsKit, 'cloudflared');
  plantBinary(depsKit, 'ngrok');
  setTunnelSpawnDepsForTests(depsKit.deps);
  const impl = (request: Record<string, unknown>): { child: FakeChild; url: string; mode: string } => {
    calls += 1;
    const mode = String(request['mode'] ?? 'quick');
    const n = calls;
    starterRequests.push({ ...request });
    if (faults.throwOnRequest !== undefined && Object.entries(faults.throwOnRequest).every(([key, value]) => request[key] === value)) {
      throw new Error('starter exploded');
    }
    // Mirror the real drivers' required-field validation so route error rows
    // stay pinned (managed-remote needs token+hostname; managed-local needs a hostname).
    const hostnameIs = typeof request['hostname'] === 'string' && request['hostname'] !== '';
    if (mode === 'managed-remote' || (mode === 'managed-local' && typeof request['configPath'] !== 'string')) {
      const tokenMissing = (mode === 'managed-remote' ? typeof request['token'] !== 'string' || request['token'] === '' : false) || !hostnameIs;
      if (tokenMissing) {
        throw new TunnelServiceError(
          'validation_error',
          mode === 'managed-remote' && (typeof request['token'] !== 'string' || request['token'] === '')
            ? 'Tunnel token is required for managed-remote tunnels'
            : mode === 'managed-remote' ? 'Tunnel hostname is required for managed-remote tunnels'
            : 'Tunnel hostname is required: use --hostname or add an ingress hostname to the config',
          'fake starter field validation',
        );
      }
    }
    const child = new FakeChild();
    children.push(child);
    const url = mode === 'quick' ? `https://qt-${n}-a-b-c.trycloudflare.com` : `https://${hostnameIs ? String(request['hostname']) : 'managed.example.com'}`;
    return { child, url, mode };
  };
  const reg = (request: Record<string, unknown>): Promise<ReturnType<typeof controllerFor>> => {
    const outcome = impl({ provider: 'cloudflare', ...(request as Record<string, unknown>) });
    return Promise.resolve(controllerFor(
      'cloudflare',
      outcome.mode as 'quick' | 'managed-local' | 'managed-remote',
      outcome.child,
      outcome.url,
      {
        resolvedHostname: typeof request['hostname'] === 'string' ? (request['hostname'] as string) : null,
        effectiveConfigPath: typeof request['configPath'] === 'string' ? (request['configPath'] as string) : null,
      },
    ));
  };
  const registry = {
    'cloudflare:quick': (port: number, request: unknown) => {
      void port;
      return reg(request as Record<string, unknown>);
    },
    'cloudflare:managed-remote': (port: number, request: unknown) => {
      void port;
      return reg(request as Record<string, unknown>);
    },
    'cloudflare:managed-local': (port: number, request: unknown) => {
      void port;
      return reg(request as Record<string, unknown>);
    },
    'ngrok:quick': (port: number, request: unknown) => {
      void port;
      return reg({ provider: 'ngrok', ...(request as Record<string, unknown>) });
    },
  };
  getTunnelService({
    dataDir: h.dir,
    localPort: 3902,
    settings: readTunnelSettingsDefaults,
    spawnDeps: depsKit.deps,
    starters: registry as never,
  });
}

beforeEach(() => {
  resetTunnelAuthForTests();
  resetTunnelServiceForTests();
  resetManagedRemoteProfileStoreForTests();
  setTunnelSpawnDepsForTests(null);
  seedTunnel();
});

afterAll(() => {
  h.dispose();
  setTunnelSpawnDepsForTests(null);
  resetTunnelServiceForTests();
  resetManagedRemoteProfileStoreForTests();
  resetTunnelAuthForTests();
});

const RAW = (path: string, headers: Record<string, string>, method = 'GET', envSocket = false): Promise<Response> => {
  const request = new Request(path, { method, headers });
  return Promise.resolve(h.server().fetch(request, envSocket
    ? { incoming: { socket: { remoteAddress: '203.0.113.9', localAddress: '192.168.1.5', localPort: 3902 } } }
    : { incoming: { socket: {} } })) as Promise<Response>;
};

const STATUS = async (): Promise<Record<string, unknown>> => await (await h.call('/api/openchamber/tunnel/status')).json() as Record<string, unknown>;

describe('tunnel route surface (§4.6)', () => {
  it('providers + check report capabilities and dependency availability with install hints', async () => {
    const providers = (await (await h.call('/api/openchamber/tunnel/providers')).json()) as { providers: Array<{ key: string; modes: unknown[] }> };
    expect(providers.providers.map((row) => row.key)).toEqual(['cloudflare', 'ngrok']);
    const check = (await (await h.call('/api/openchamber/tunnel/check?provider=cloudflare')).json()) as Record<string, unknown>;
    expect(check).toMatchObject({ available: true, provider: 'cloudflare', dependency: 'cloudflared', platform: process.platform });
    expect(String(check['installCommand'])).toMatch(/brew|winget/u);
    delete process.env.NGROK_AUTHTOKEN;
    const ngrok = (await (await h.call('/api/openchamber/tunnel/check?provider=ngrok')).json()) as Record<string, unknown>;
    expect(ngrok['available']).toBe(true);
  });

  it('tunnel-scope VISITORS may read diagnostics but never control the plane (review P1 gate parity)', async () => {
    const started = (await (await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: {} })).json()) as Record<string, unknown>;
    const connect = await RAW(String(started['connectUrl']), {});
    const cookie = connect.headers.getSetCookie().find((row) => row.startsWith('oc_tunnel_session='))!.split(';')[0]!;
    const host = String(started['url']).replace('https://', '');
    // reads stay admissible at tunnel scope (local-anonymous level)
    const status = await RAW(`http://${host}/api/openchamber/tunnel/status`, { cookie });
    expect(status.status).toBe(200);
    const probe = await RAW(`http://${host}/api/openchamber/tunnel/providers`, { cookie });
    expect(probe.status).toBe(200);
    // the operator verbs are not guest verbs
    const stop = await RAW(`http://${host}/api/openchamber/tunnel/stop`, { cookie }, 'POST');
    expect(stop.status).toBe(403);
    expect((await stop.json()) as Record<string, unknown>).toMatchObject({ tunnelLocked: true, code: 'tunnel_locked' });
    const restart = await RAW(`http://${host}/api/openchamber/tunnel/start`, { cookie, 'content-type': 'application/json' }, 'POST');
    expect(restart.status).toBe(403);
    const tokenWrite = await RAW(`http://${host}/api/openchamber/tunnel/managed-remote-token`, { cookie, 'content-type': 'application/json' }, 'PUT');
    expect(tokenWrite.status).toBe(403);
  });

  it('doctor rejects an unknown mode with the §5.34 400 {ok:false} row', async () => {
    const bad = (await (await h.call('/api/openchamber/tunnel/doctor?provider=cloudflare&mode=wishful')).json()) as Record<string, unknown>;
    expect(bad).toMatchObject({ ok: false, code: 'mode_unsupported' });
    expect(await h.call('/api/openchamber/tunnel/doctor?provider=frp').then((r) => r.status)).toBe(400);
  });

  it('doctor builds per-mode checks; the CLI-parity flag satisfies the token prerequisite without tokens in URLs', async () => {
    const failing = (await (await h.call('/api/openchamber/tunnel/doctor?provider=cloudflare&mode=managed-remote')).json()) as {
      providerChecks: Array<{ id: string; status: string }>;
      modes: Array<{ mode: string; ready: boolean; blockers: string[]; summary: { failures: number } }>;
    };
    expect(failing.providerChecks[0]!.id).toBe('binary');
    const remote = failing.modes[0]!;
    expect(remote.mode).toBe('managed-remote');
    expect(remote.ready).toBe(false);
    expect(remote.blockers.join(' ')).toContain('token');
    const cliFlag = (await (await h.call('/api/openchamber/tunnel/doctor?provider=cloudflare&mode=managed-remote&hostname=dr.example.com&hasSavedManagedRemoteProfile=1')).json()) as {
      modes: Array<{ ready: boolean; summary: { failures: number } }>;
    };
    expect(cliFlag.modes[0]!.ready).toBe(true);
    expect(cliFlag.modes[0]!.summary.failures).toBe(0);
    const post = await h.call('/api/openchamber/tunnel/doctor', {
      method: 'POST',
      body: { provider: 'cloudflare', mode: 'managed-remote', tokenProvided: true, token: 'secret-doctor-token', hostname: 'post.example.com' },
    });
    expect(post.status).toBe(200);
    const postBody = JSON.stringify((await post.json()) as unknown);
    expect(postBody).not.toContain('secret-doctor-token'); // POST body never echoed
    expect(JSON.parse(postBody) as { modes: Array<{ ready: boolean }> }).toMatchObject({ modes: [{ ready: true }] });
  });

  it('managed-local doctor reads the §4.2-validated config path and the ingress hostname', async () => {
    const configPath = `${h.dir}/cfg.yml`.replaceAll('\\', '/');
    depsKit!.io.existsSet.add(configPath);
    depsKit!.io.sizeMap.set(configPath, 96);
    depsKit!.io.readTextMap.set(configPath, 'ingress:\n  - hostname: doctor.example.com\n    service: http://localhost:3902\n');
    const report = (await (await h.call(`/api/openchamber/tunnel/doctor?provider=cloudflare&mode=managed-local&configPath=${encodeURIComponent(configPath)}`)).json()) as {
      modes: Array<{ mode: string; checks: Array<{ id: string; status: string; detail: string }>; ready: boolean }>;
    };
    const mode = report.modes[0]!;
    expect(mode.ready).toBe(true);
    expect(mode.checks.find((row) => row.id === 'config')!.status).toBe('ok');
    expect(mode.checks.find((row) => row.id === 'hostname')!.detail).toBe('doctor.example.com');
  });

  it('managed-remote-token upsert validates the four fields and returns ids only', async () => {
    const missing = await h.call('/api/openchamber/tunnel/managed-remote-token', { method: 'PUT', body: { presetId: 'p1' } });
    expect(missing.status).toBe(400);
    expect(String(((await missing.json()) as Record<string, unknown>)['error'])).toContain('presetName');
    const created = await h.call('/api/openchamber/tunnel/managed-remote-token', {
      method: 'PUT',
      body: { presetId: 'p1', presetName: 'P One', managedRemoteTunnelHostname: 'saved.example.com', managedRemoteTunnelToken: 'saved-token-xyz' },
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ ok: true, managedRemoteTunnelTokenPresetIds: ['p1'] });
    const status = await STATUS();
    expect(JSON.stringify(status)).not.toContain('saved-token-xyz'); // §12.1: tokens never echo
    expect(status['managedRemoteTunnelTokenPresetIds']).toEqual(['p1']);
  });

  it('status answers inactive with the tunnel-gated policy before any start', async () => {
    const status = await STATUS();
    expect(status).toMatchObject({
      active: false,
      hasBootstrapToken: false,
      policy: 'tunnel-gated',
      localPort: 3902,
      ttlConfig: { bootstrapTtlMs: 30 * 60_000, sessionTtlMs: 8 * 60 * 60_000 },
    });
  });
});

describe('start -> connect -> replace -> stop lifecycle (§4.7)', () => {
  it('start issues the one-time /connect link; redeem 302s with the Lax cookie and burns the token', async () => {
    const started = (await (await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: {} })).json()) as Record<string, unknown>;
    expect(started['ok']).toBe(true);
    expect(String(started['url'])).toMatch(/^https:\/\/qt-1-a-b-c\.trycloudflare\.com$/u);
    expect(String(started['policy'])).toBe('tunnel-gated');
    const connectUrl = String(started['connectUrl']);
    expect(connectUrl).toContain('/connect?t=');
    const token = new URL(connectUrl).searchParams.get('t')!;
    const connect = await RAW(connectUrl, {});
    expect(connect.status).toBe(302);
    expect(connect.headers.get('location')).toBe('/');
    expect(connect.headers.get('cache-control')).toBe('no-store');
    const cookies = connect.headers.getSetCookie();
    const sessionCookie = cookies.find((row) => row.startsWith('oc_tunnel_session='))!;
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Max-Age=');
    const reuse = await RAW(connectUrl, {});
    expect(reuse.status).toBe(401);
    expect(await reuse.text()).toBe('Connection link is invalid or expired.');
    void token;
  });

  it('tunnel-scope /api uses the tunnel session (Host classifier); credential endpoints stay locked', async () => {
    const started = (await (await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: {} })).json()) as Record<string, unknown>;
    const connectUrl = String(started['connectUrl']);
    const connect = await RAW(connectUrl, {});
    const cookie = connect.headers.getSetCookie().find((row) => row.startsWith('oc_tunnel_session='))!.split(';')[0]!;
    const admitted = await RAW(`http://qt-1-a-b-c.trycloudflare.com/api/config/settings?surface=web`, { cookie });
    expect(admitted.status).toBe(200);
    const denied = await RAW(`http://qt-1-a-b-c.trycloudflare.com/api/config/settings?surface=web`, {});
    expect(denied.status).toBe(401);
    expect((await denied.json()) as Record<string, unknown>).toMatchObject({
      error: 'Tunnel authentication required', locked: true, tunnelLocked: true,
    });
    const loginBlocked = await RAW(`http://qt-1-a-b-c.trycloudflare.com/auth/session`, { 'content-type': 'application/json' }, 'POST');
    expect(loginBlocked.status).toBe(403);
    expect((await loginBlocked.json()) as Record<string, unknown>).toMatchObject({
      error: 'Password login is disabled for tunnel scope', tunnelLocked: true,
    });
    const sessionStatus = await RAW(`http://qt-1-a-b-c.trycloudflare.com/auth/session`, { cookie });
    expect((await sessionStatus.json()) as Record<string, unknown>).toMatchObject({ authenticated: true, scope: 'tunnel' });
  });

  it('a replaced tunnel invalidates the old artifacts; the clarified start reports replacement geometry', async () => {
    const first = (await (await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: {} })).json()) as Record<string, unknown>;
    const connect = await RAW(String(first['connectUrl']), {});
    const oldCookie = connect.headers.getSetCookie().find((row) => row.startsWith('oc_tunnel_session='))!.split(';')[0]!;
    const second = (await (await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: { provider: 'cloudflare', mode: 'quick' } })).json()) as Record<string, unknown>;
    expect(second['replacedTunnel']).toBe(true);
    expect(second['replaced']).toEqual({ mode: 'quick', provider: 'cloudflare', url: first['url'] });
    expect(second['revokedBootstrapCount']).toBe(1);
    expect(second['invalidatedSessionCount']).toBe(1);
    expect(String(second['url'])).toContain('qt-2-');
    const stale = await RAW(`http://qt-1-a-b-c.trycloudflare.com/api/config/settings?surface=web`, { cookie: oldCookie });
    expect(stale.status).toBe(401); // old session dead, and the old host no longer classifies as the active tunnel
    const newConnect = await RAW(String(second['connectUrl']), {});
    expect(newConnect.status).toBe(302);
  });

  it('managed-remote start resolves the store token; a plain Error surfaces as startup_failed 500', async () => {
    await getManagedRemoteProfileStore({ dataDir: h.dir }).upsert({
      id: 'p1', name: 'P1', hostname: 'store.example.com', token: 'store-token-abc',
    });
    const started = (await (await h.call('/api/openchamber/tunnel/start', {
      method: 'POST',
      body: { mode: 'managed-remote', hostname: 'store.example.com' },
    })).json()) as Record<string, unknown>;
    expect(started['ok']).toBe(true);
    expect(starterRequests[0]).toMatchObject({ token: 'store-token-abc', hostname: 'store.example.com', mode: 'managed-remote', intent: 'persistent-public' });
    const invalid = await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: { mode: 'managed-remote', hostname: 'other.example.com' } });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as Record<string, unknown>).toMatchObject({ error: 'Tunnel token is required for managed-remote tunnels', code: 'validation_error' });
    resetTunnelServiceForTests();
    seedTunnel({ throwOnRequest: { hostname: 'boom.example.com' } });
    const failure = await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: { mode: 'managed-remote', hostname: 'boom.example.com', token: 't' } });
    expect(failure.status).toBe(500);
    expect((await failure.json()) as Record<string, unknown>).toMatchObject({ code: 'startup_failed' });
    const after = (await (await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: { mode: 'managed-remote', hostname: 'after.example.com', token: 't2' } })).json()) as Record<string, unknown>;
    expect(after['ok']).toBe(true); // the mutex continues past rejections
  });

  it('422 mapping for explicitly unsupported provider/mode selections', async () => {
    const badProvider = await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: { provider: 'frp' } });
    expect(badProvider.status).toBe(422);
    expect((await badProvider.json()) as Record<string, unknown>).toMatchObject({ code: 'provider_unsupported' });
    const badMode = await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: { mode: 'wishful', intent: 'persistent-public' } });
    expect(badMode.status).toBe(422);
    expect((await badMode.json()) as Record<string, unknown>).toMatchObject({ code: 'mode_unsupported' });
  });

  it('stop revokes with counts, leaves status inactive, and the dead link answers 401', async () => {
    const started = (await (await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: {} })).json()) as Record<string, unknown>;
    const connectUrl = String(started['connectUrl']);
    await RAW(connectUrl, {}); // burn the bootstrap into a session
    const stopped = (await (await h.call('/api/openchamber/tunnel/stop', { method: 'POST', body: {} })).json()) as Record<string, unknown>;
    expect(stopped).toMatchObject({ ok: true, revokedBootstrapCount: 1, invalidatedSessionCount: 1 });
    const status = await STATUS();
    expect(status['active']).toBe(false);
    expect((status['activeSessions'] as Array<Record<string, unknown>>).length).toBe(1); // listed, revoked
    const reuse2 = await RAW(connectUrl, {});
    expect(reuse2.status).toBe(401);
  });

  it('system/info carries the live tunnel URL once a tunnel is active', async () => {
    const before = (await (await h.call('/api/system/info')).json()) as { tunnelUrl: string | null };
    expect(before.tunnelUrl).toBe(null);
    const started = (await (await h.call('/api/openchamber/tunnel/start', { method: 'POST', body: {} })).json()) as Record<string, unknown>;
    const info = (await (await h.call('/api/system/info')).json()) as { tunnelUrl: string | null; port: number; pid: number };
    expect(info.tunnelUrl).toBe(started['url']);
    expect(info.port).toBe(3902);
    expect(info.pid).toBeTypeOf('number');
  });
});
