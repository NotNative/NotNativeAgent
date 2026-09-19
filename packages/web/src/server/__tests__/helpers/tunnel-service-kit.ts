// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel-service test kit: a fresh TunnelService with an injected
 * fresh-controller starter (per-call FakeChild), its own
 * TunnelAuthController + profile store, and the §4.4/§11.2 settings
 * reader stub. Call/outcome state is exposed for pinning the lifecycle.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join as pathJoin, sep } from 'node:path';
import { TunnelService, type TunnelServiceOptions, type TunnelSettingsDefaults } from '../../lib/tunnels/tunnel-service.ts';
import { ManagedRemoteProfileStore } from '../../lib/tunnels/tunnel-profile-store.ts';
import { createTunnelAuthController, type TunnelAuthController } from '../../lib/auth/tunnel-auth.ts';
import type { NormalizedTunnelStartRequest } from '../../lib/tunnels/tunnel-validate.ts';
import type { TunnelStarterRegistry } from '../../lib/tunnels/tunnel-starters.ts';
import type { TunnelControllerLike } from '../../lib/tunnels/tunnel-controller.ts';
import { FakeChild, controllerFor, fakeSpawnDeps } from './tunnel-fakes.ts';

export interface TunnelServiceKit {
  service: TunnelService;
  tunnelAuth: TunnelAuthController;
  store: ManagedRemoteProfileStore;
  calls: Array<{ port: number; request: NormalizedTunnelStartRequest }>;
  children: FakeChild[];
  childFor: (index: number) => FakeChild;
  root: string;
}

export interface MakeServiceOptions {
  controller?: (call: { port: number; request: NormalizedTunnelStartRequest; child: FakeChild; n: number }) => TunnelControllerLike;
  settings?: Partial<TunnelSettingsDefaults>;
  urlFor?: (request: NormalizedTunnelStartRequest, n: number) => string;
}

export function makeTunnelService(options: MakeServiceOptions = {}): TunnelServiceKit {
  const root = mkdtempSync(`${osTmpdir()}${sep}nnd-tunnel-svc-`);
  const tunnelAuth = createTunnelAuthController({ bootstrapTtlMs: 15_000, sessionTtlMs: 30 * 60_000 });
  const store = new ManagedRemoteProfileStore(root);
  const calls: TunnelServiceKit['calls'] = [];
  const children: FakeChild[] = [];
  let callCount = 0;
  const completeSettings = (): TunnelSettingsDefaults => ({
    provider: undefined,
    mode: undefined,
    managedLocalTunnelConfigPath: undefined,
    managedRemoteTunnelHostname: undefined,
    managedRemoteTunnelToken: undefined,
    tunnelBootstrapTtlMs: 15_000,
    tunnelSessionTtlMs: 30 * 60_000,
    ...(options.settings ?? {}),
  });
  const starter = (port: number, request: NormalizedTunnelStartRequest, _deps: unknown): Promise<TunnelControllerLike> => {
    callCount += 1;
    calls.push({ port, request });
    const child = new FakeChild();
    children.push(child);
    if (options.controller !== undefined) {
      return Promise.resolve(options.controller({ port, request, child, n: callCount }));
    }
    const url = options.urlFor !== undefined
      ? options.urlFor(request, callCount)
      : request.mode === 'quick'
        ? `https://${callCount}-abc-de.trycloudflare.com`
        : `https://${request.hostname ?? 'fallback.example.dev'}`;
    return Promise.resolve(controllerFor(
      request.provider,
      request.mode,
      child,
      url,
      { resolvedHostname: request.hostname, effectiveConfigPath: request.configPath },
    ));
  };
  const registry: TunnelStarterRegistry = {
    'cloudflare:quick': starter,
    'cloudflare:managed-remote': starter,
    'cloudflare:managed-local': starter,
    'ngrok:quick': starter,
  };
  const serviceOptions: TunnelServiceOptions = {
    dataDir: root,
    localPort: 4001,
    settings: completeSettings,
    tunnelAuth,
    profileStore: store,
    spawnDeps: fakeSpawnDeps(root).deps,
    starters: registry,
  };
  const service = new TunnelService(serviceOptions);
  const childFor = (index: number): FakeChild => children[index] as FakeChild;
  return { service, tunnelAuth, store, calls, children, childFor, root };
}
