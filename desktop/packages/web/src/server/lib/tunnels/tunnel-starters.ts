// SPDX-License-Identifier: Apache-2.0
/**
 * Provider starter registry (doc 08 §4.2/§4.3): `provider:mode` → starter.
 * Starters receive the normalized request + spawn deps so tests inject
 * fakes while production binds `realSpawnDeps()`.
 */
import type { NormalizedTunnelStartRequest } from './tunnel-validate.ts';
import type { TunnelSpawnDeps } from './tunnel-spawn.ts';
import type { TunnelControllerLike } from './tunnel-controller.ts';
import { startCloudflareQuickTunnel } from './cloudflare-quick.ts';
import { startCloudflareManagedLocalTunnel, startCloudflareManagedRemoteTunnel } from './cloudflare-managed.ts';
import { startNgrokQuickTunnel } from './ngrok-tunnel.ts';

export type TunnelStarter = (
  port: number,
  request: NormalizedTunnelStartRequest,
  deps: TunnelSpawnDeps,
) => Promise<TunnelControllerLike>;

export type TunnelStarterRegistry = Record<`${string}:${string}`, TunnelStarter>;

export function buildDefaultStarters(): TunnelStarterRegistry {
  return {
    'cloudflare:quick': (port, request, deps) => startCloudflareQuickTunnel(port, { deps }),
    'cloudflare:managed-remote': (port, request, deps) =>
      startCloudflareManagedRemoteTunnel(port, { token: request.token, hostname: request.hostname }, { deps }),
    'cloudflare:managed-local': (port, request, deps) =>
      startCloudflareManagedLocalTunnel(port, { configPath: request.configPath, hostname: request.hostname }, { deps }),
    'ngrok:quick': (port, request, deps) => startNgrokQuickTunnel(port, { deps }),
  };
}
