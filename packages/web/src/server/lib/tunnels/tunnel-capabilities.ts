// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel capability registry (doc 08 §4.1): provider/mode descriptors with
 * intent, requirement ids, supported feature tags, and stability. Unknown
 * or blank selections fall back (mode → quick, provider → cloudflare);
 * mode→intent defaults: quick = ephemeral-public, managed-* =
 * persistent-public. `private-network` is a recognized intent STRING that
 * no provider mode ever emits (§4.2: carrying it fails the intent match).
 */
export type TunnelProvider = 'cloudflare' | 'ngrok';
export type TunnelMode = 'quick' | 'managed-local' | 'managed-remote';
export type TunnelIntent = 'ephemeral-public' | 'persistent-public' | 'private-network';
export type TunnelStability = 'ga' | 'beta';

export interface TunnelModeCapability {
  key: TunnelMode;
  label: string;
  intent: TunnelIntent;
  requires: readonly string[];
  supports: readonly string[];
  stability: TunnelStability;
}

export interface TunnelProviderInstallHint {
  command: string;
  url: string;
}

export interface TunnelProviderCapability {
  key: TunnelProvider;
  label: string;
  /** `candidateBinary` — the executable the provider spawns. */
  dependency: string;
  modes: readonly TunnelModeCapability[];
  install: Record<'linux' | 'darwin' | 'win32', TunnelProviderInstallHint>;
}

export const INSTALL_SUGGESTION_FRAGMENTS = {
  linux: 'brew',
  darwin: 'brew',
  win32: 'winget',
} as const;

export function cloudflareTunnelProviderCapabilities(): TunnelProviderCapability {
  return {
    key: 'cloudflare',
    label: 'Cloudflare Zero Trust tunnels',
    dependency: 'cloudflared',
    modes: [
      {
        key: 'quick',
        label: 'Quick (ephemeral trycloudflare URL)',
        intent: 'ephemeral-public',
        requires: ['binary'],
        supports: ['sessionTTL'],
        stability: 'ga',
      },
      {
        key: 'managed-remote',
        label: 'Managed remote (run token + hostname)',
        intent: 'persistent-public',
        requires: ['binary', 'token', 'hostname'],
        supports: ['customDomain', 'sessionTTL'],
        stability: 'ga',
      },
      {
        key: 'managed-local',
        label: 'Managed local (cloudflared config file)',
        intent: 'persistent-public',
        requires: ['binary', 'configFile'],
        supports: ['configFile', 'customDomain', 'sessionTTL'],
        stability: 'ga',
      },
    ],
    install: {
      linux: { command: 'brew install cloudflared', url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' },
      darwin: { command: 'brew install cloudflared', url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' },
      win32: { command: 'winget install --id Cloudflare.cloudflared', url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' },
    },
  };
}

export function ngrokTunnelProviderCapabilities(): TunnelProviderCapability {
  return {
    key: 'ngrok',
    label: 'ngrok quick tunnels',
    dependency: 'ngrok',
    modes: [
      {
        key: 'quick',
        label: 'Quick (ephemeral *.ngrok-*.io URL)',
        intent: 'ephemeral-public',
        requires: ['binary', 'authtoken'],
        supports: ['sessionTTL'],
        stability: 'beta',
      },
    ],
    install: {
      linux: { command: 'brew install ngrok', url: 'https://ngrok.com/download' },
      darwin: { command: 'brew install ngrok', url: 'https://ngrok.com/download' },
      win32: { command: 'winget install --id ngrok.ngrok', url: 'https://ngrok.com/download' },
    },
  };
}

export const TUNNEL_PROVIDER_CAPABILITIES: readonly TunnelProviderCapability[] = [
  cloudflareTunnelProviderCapabilities(),
  ngrokTunnelProviderCapabilities(),
];

/** Unknown/blank mode ⇒ quick (§4.1), unknown/blank provider ⇒ cloudflare. */
export const DEFAULT_TUNNEL_PROVIDER: TunnelProvider = 'cloudflare';
export const DEFAULT_TUNNEL_MODE: TunnelMode = 'quick';

export function modeIntentDefault(mode: TunnelMode): TunnelIntent {
  return mode === 'quick' ? 'ephemeral-public' : 'persistent-public';
}

export function tunnelModeCapability(
  provider: TunnelProvider,
  mode: TunnelMode,
): TunnelModeCapability {
  const registry = provider === 'ngrok' ? ngrokTunnelProviderCapabilities() : cloudflareTunnelProviderCapabilities();
  const found = registry.modes.find((entry) => entry.key === mode);
  return found ?? registry.modes[0]!;
}

/** `private-network` is a supported string; only the two public intents
 * match a mode descriptor (§4.1 fallback rules). */
export function normalizeTunnelIntent(value: unknown): TunnelIntent {
  return value === 'private-network' ? 'private-network'
    : value === 'ephemeral-public' ? 'ephemeral-public'
    : value === 'persistent-public' ? 'persistent-public'
    : modeIntentDefault(DEFAULT_TUNNEL_MODE);
}
