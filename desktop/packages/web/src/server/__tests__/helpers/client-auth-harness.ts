// SPDX-License-Identifier: Apache-2.0
/**
 * Shared harness for the P8-4a client-auth route gates: one temp dataDir
 * per harness instance, a once-built Hono app (routes carry the redeem
 * limiter state), the relay service fake kit, and the per-test slate
 * helpers (pairing file/claim/config cleaned; client records drainable).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { createApp } from '../../app.ts';
import { getRelayHostService, resetRelayHostServiceForTests } from '../../lib/relay/host-service.ts';
import type { ManagedHost } from '../../lib/relay/host-service-types.ts';
import { relayConfigPath } from '../../lib/relay/relay-config.ts';
import { getPairingSessionStore, resetPairingSessionStoreForTests } from '../../lib/auth/pairing-sessions.ts';
import { getUiAuthController, resetUiAuthForTests } from '../../lib/auth/ui-auth.ts';
import { resetSharedRelayIdentityForTests } from '../../lib/relay/identity.ts';

export interface Kit {
  hosts: { started: string[]; stopped: number; state: 'connected' | 'disabled' }[];
  factory: (identity: unknown, relayUrl: string) => Promise<ManagedHost>;
}

export type AppServer = { fetch: (request: Request, env?: unknown) => Response | Promise<Response> };

export interface SocketSpec { remoteAddress?: string; localAddress?: string; localPort?: number }

export interface ClientAuthHarness {
  dir: string;
  server: () => AppServer;
  call: (path: string, init?: { method?: string; body?: unknown; cookie?: string; socket?: SocketSpec }) => Promise<Response>;
  bearer: (path: string, token: string, method?: string, body?: unknown) => Promise<Response>;
  seedService: (demand: 'true' | 'false' | 'real') => Kit;
  resetPairingSlate: () => void;
  drainClients: () => Promise<void>;
  mintViaRoute: (label: string, kind: string) => Promise<{ token: string; client: Record<string, unknown>; clientId: string }>;
  configEnabled: () => boolean;
  waitUntil: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
  dispose: () => void;
}

export function createClientAuthHarness(): ClientAuthHarness {
  const dir = mkdtempSync(`${tmpdir()}${sep}nnd-p84-harness-`);
  process.env.NOTNATIVE_DATA_DIR = dir;
  delete process.env.NOTNATIVE_UI_PASSWORD;
  delete process.env.NOTNATIVE_RELAY_URL;
  delete process.env.NOTNATIVE_RELAY_HOST;
  delete process.env.NOTNATIVE_ELECTRON_DEV;
  let app: AppServer | null = null;

  function server(): AppServer {
    if (app === null) {
      const built = createApp(); // built ONCE: route registrations carry limiter state
      app = { fetch: (raw, env) => built.fetch(raw, env) };
    }
    return app;
  }

  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; socket?: SocketSpec } = {}): Promise<Response> => {
    const headers = new Headers();
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.cookie !== undefined) headers.set('cookie', init.cookie);
    const request = new Request(`http://127.0.0.1:3902${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return Promise.resolve(server().fetch(request, { incoming: { socket: init.socket ?? {} } }));
  };

  const bearer = (path: string, token: string, method: string = 'GET', body?: unknown): Promise<Response> => {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const request = new Request(`http://127.0.0.1:3902${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return Promise.resolve(server().fetch(request, { incoming: { socket: {} } }));
  };

  function fakeKit(): Kit {
    const hosts: Kit['hosts'] = [];
    const factory = async (_identity: unknown, relayUrl: string): Promise<ManagedHost> => {
      const record: Kit['hosts'][number] = { started: [relayUrl], stopped: 0, state: 'connected' };
      hosts.push(record);
      return {
        start: async () => { record.started.push(relayUrl); },
        stop: () => { record.stopped += 1; record.state = 'disabled'; },
        getStatus: () => ({
          state: record.state,
          serverId: 'srv-test',
          connectedClients: 0,
          relayUrl: record.started[0] ?? null,
          lastError: null,
        }),
      };
    };
    return { hosts, factory };
  }

  function seedService(demand: 'true' | 'false' | 'real'): Kit {
    resetRelayHostServiceForTests(); // getRelayHostService ignores options once a singleton exists
    const kitLocal = fakeKit();
    const port = 3902;
    const signals = demand === 'true' ? [(): boolean => true]
      : demand === 'real' ? [
          () => getUiAuthController().hasActiveRelayClients(),
          () => getPairingSessionStore().hasActiveRelaySession(),
        ]
    : [(): boolean => false];
    getRelayHostService({
      dataDir: dir,
      demandSignals: signals,
      hostFactory: kitLocal.factory,
      timing: { claimWatcherMs: 10, demandPollMs: 60_000, claimTakeoverGraceMs: 120 },
      localPort: port,
    });
    return kitLocal;
  }

  function resetPairingSlate(): void {
    resetRelayHostServiceForTests();
    resetPairingSessionStoreForTests();
    for (const name of ['client-pairing-sessions.json', 'relay-config.json', 'relay-host.lock']) {
      rmSync(`${dir}/${name}`, { force: true });
    }
    getPairingSessionStore({
      dataDir: dir,
      mintClient: (input) => getUiAuthController().getClientStore().createClient(input),
    });
  }

  async function drainClients(): Promise<void> {
    const list = (await (await call('/api/client-auth/clients')).json()) as { clients: Array<{ id: string }> };
    for (const row of list.clients) await call(`/api/client-auth/clients/${row.id}`, { method: 'DELETE' });
    await call('/api/client-auth/clients', { method: 'DELETE' });
  }

  async function mintViaRoute(label: string, kind: string): Promise<{ token: string; client: Record<string, unknown>; clientId: string }> {
    const minted = await call('/api/client-auth/clients', { method: 'POST', body: { label, clientKind: kind } });
    const parsed = (await minted.json()) as { token: string; client: Record<string, unknown> };
    return { token: parsed.token, client: parsed.client, clientId: String(parsed.client['id']) };
  }

  function configEnabled(): boolean {
    try {
      const raw = JSON.parse(readFileSync(relayConfigPath(dir), 'utf8')) as { enabled?: boolean };
      return raw.enabled === true;
    } catch {
      return false;
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      if (predicate()) return;
      await sleep(10);
    }
    throw new Error('condition not reached in time');
  }

  function dispose(): void {
    resetRelayHostServiceForTests();
    resetPairingSessionStoreForTests();
    resetSharedRelayIdentityForTests();
    resetUiAuthForTests();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.NOTNATIVE_UI_PASSWORD;
  }

  return {
    dir, server, call, bearer, seedService,
    resetPairingSlate, drainClients, mintViaRoute, configEnabled, waitUntil, dispose,
  };
}

/** Process-wide memo: both route-gate files share one harness (one dataDir,
 * one app instance, one limiter) so singleton binding stays consistent
 * within a worker. Files dispose idempotently in afterAll. */
let memo: ClientAuthHarness | null = null;

export function clientAuthHarness(): ClientAuthHarness {
  if (memo === null) memo = createClientAuthHarness();
  return memo;
}
