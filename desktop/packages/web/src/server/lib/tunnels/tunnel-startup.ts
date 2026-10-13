// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel plane boot (doc 08 §4.5/§4.7): TTL settings re-clamp into the
 * live controller, service singleton seeding (routes + status resolve the
 * same instance), and the §4.7 startup tunnel (env request → print the
 * one-time connect link; failures degrade to no tunnel and never abort
 * the server). Returns the async dispose used by the graceful shutdown.
 */
import { ENV } from '../../env.ts';
import { getTunnelAuthController } from '../auth/tunnel-auth.ts';
import { getTunnelService } from './tunnel-service.ts';
import { readEnvTunnelRequest, readTunnelSettingsDefaults } from './tunnel-settings.ts';

export function wireTunnelPlane(): { dispose: () => Promise<void> } {
  const defaults = readTunnelSettingsDefaults();
  const tunnelAuth = getTunnelAuthController();
  tunnelAuth.applyBootstrapTtl(defaults.tunnelBootstrapTtlMs);
  tunnelAuth.applySessionTtl(defaults.tunnelSessionTtlMs);
  const tunnelService = getTunnelService({
    dataDir: ENV.dataDir,
    localPort: ENV.port,
    settings: readTunnelSettingsDefaults,
  });
  const startupTunnel = readEnvTunnelRequest();
  if (startupTunnel !== null) {
    void tunnelService.start(startupTunnel).then((outcome) => {
      console.log(`Tunnel ready: ${outcome.url}`);
      console.log('One-time connect link — expires after first use:');
      console.log(`${outcome.url}/connect?t=${outcome.bootstrapToken}`);
    }).catch((error) => {
      console.warn(`Startup tunnel failed (server continues): ${String(error)}`);
    });
  }
  return {
    dispose: () => tunnelService.dispose(),
  };
}
