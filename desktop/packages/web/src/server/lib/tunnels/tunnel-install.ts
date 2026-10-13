// SPDX-License-Identifier: Apache-2.0
/**
 * Install-surfaces text for the tunnel `check`/`doctor` routes (doc 03
 * §5.34: install hints per platform — cloudflared brew/winget/download;
 * ngrok brew/winget-store/download). Test parity with the capability
 * registry lives here (single source of the strings).
 */
import type { TunnelSpawnDeps } from './tunnel-spawn.ts';
import { TUNNEL_PROVIDER_CAPABILITIES, type TunnelProvider } from './tunnel-capabilities.ts';

export const CLOUDFLARE_INSTALL_HINT = 'install cloudflared (brew install cloudflared / winget install --id Cloudflare.cloudflared)';
export const NGROK_INSTALL_HINT = 'install ngrok (brew install ngrok / winget install --id ngrok.ngrok)';

export function installHintFor(provider: TunnelProvider, platform: NodeJS.Platform = process.platform): string {
  const providerCapability = TUNNEL_PROVIDER_CAPABILITIES.find((entry) => entry.key === provider);
  const platformHints = providerCapability?.install;
  const hint = platformHints === undefined
    ? undefined
    : platform === 'win32' ? platformHints.win32 : platform === 'darwin' ? platformHints.darwin : platformHints.linux;
  return hint ? `${hint.command} (${hint.url})` : '';
}

/** §4.6 `check` route contract rows (provider availability + hints). */
export function providerCheckFor(
  provider: TunnelProvider,
  probe: { available: boolean; version: string | null },
  deps: TunnelSpawnDeps,
): {
  available: boolean;
  provider: TunnelProvider;
  version: string | null;
  dependency: string;
  platform: NodeJS.Platform;
  installCommand: string;
  installUrl: string;
  message: string | null;
} {
  const providerCapability = TUNNEL_PROVIDER_CAPABILITIES.find((entry) => entry.key === provider)!;
  const platform = deps.platform();
  const hint = platform === 'win32' ? providerCapability.install.win32 : providerCapability.install.darwin && platform === 'darwin' ? providerCapability.install.darwin : providerCapability.install.linux;
  return {
    available: probe.available,
    provider,
    version: probe.version,
    dependency: providerCapability.dependency,
    platform,
    installCommand: hint.command,
    installUrl: hint.url,
    message: probe.available
      ? null
      : `The ${providerCapability.dependency} CLI is not on PATH. Try: ${hint.command} (${hint.url})`,
  };
}
