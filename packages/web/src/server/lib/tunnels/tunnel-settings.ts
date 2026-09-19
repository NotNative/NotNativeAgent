// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel settings plumbing (doc 08 §11.2 + doc 03 §5.6): the seven
 * registered keys code the preferred provider/mode, managed fields,
 * and the bootstrap/session TTL clamps. `readTunnelSettingsDefaults` feeds
 * the service resolution chain (§4.4 — the token secret reaches the
 * resolver only, never a response); `wireTunnelSettings` installs runtime
 * TTL updates after any settings write; `readEnvTunnelRequest` answers the
 * §4.7 startup-tunnel env request (NND brand of OPENCHAMBER_TUNNEL_*).
 */
import { readMergedSettings, readStoredSecretValue } from '../settings-store.ts';
import { clampBootstrapTtl, clampSessionTtl, getTunnelAuthController } from '../auth/tunnel-auth.ts';

export const TUNNEL_SETTINGS_KEYS = [
  'tunnelProvider',
  'tunnelMode',
  'managedLocalTunnelConfigPath',
  'managedRemoteTunnelHostname',
  'managedRemoteTunnelToken',
  'tunnelBootstrapTtlMs',
  'tunnelSessionTtlMs',
] as const satisfies readonly string[];

export interface TunnelSettingsDefaults {
  provider: unknown;
  mode: unknown;
  managedLocalTunnelConfigPath: unknown;
  managedRemoteTunnelHostname: unknown;
  managedRemoteTunnelToken: unknown;
  tunnelBootstrapTtlMs: number | null;
  tunnelSessionTtlMs: number;
}

function docValue(key: string): unknown {
  const values = readMergedSettings('web') as Record<string, unknown>;
  return values[key];
}

/** Bootstrap TTL row: explicit `null` disables expiry (§4.5); junk rides
 * the clamped 30-min default. */
function resolvedBootstrapTtl(raw: unknown): number | null {
  if (raw === null) return null;
  return clampBootstrapTtl(raw as number | null | undefined).ms;
}

/** §4.5 session TTL: clamps junk to the 8 h default. */
function resolvedSessionTtl(raw: unknown): number {
  return clampSessionTtl(raw as number | undefined);
}

export function readTunnelSettingsDefaults(): TunnelSettingsDefaults {
  const rawBootstrap = docValue('tunnelBootstrapTtlMs');
  const rawSession = docValue('tunnelSessionTtlMs');
  return {
    provider: docValue('tunnelProvider'),
    mode: docValue('tunnelMode'),
    managedLocalTunnelConfigPath: docValue('managedLocalTunnelConfigPath'),
    managedRemoteTunnelHostname: docValue('managedRemoteTunnelHostname'),
    managedRemoteTunnelToken: readStoredSecretValue('managedRemoteTunnelToken'),
    tunnelBootstrapTtlMs: resolvedBootstrapTtl(rawBootstrap),
    tunnelSessionTtlMs: resolvedSessionTtl(rawSession),
  };
}

/** Runtime update hook for the two TTL keys (§4.5): a settings write that
 * touches tunnel keys re-clamps both values into the live controller —
 * EXPLICIT null disables expiry; junk (non-number, non-null) falls through
 * to the clamped defaults exactly like the read path (review P1: junk must
 * never become "expiry disabled"). Never throws. */
export function wireTunnelSettings(patch: Record<string, unknown>): void {
  if (!TUNNEL_SETTINGS_KEYS.some((key) => key in patch)) return;
  try {
    const controller = getTunnelAuthController();
    if (patch.tunnelBootstrapTtlMs !== undefined) {
      const raw = patch.tunnelBootstrapTtlMs;
      controller.applyBootstrapTtl(raw === null ? null : typeof raw === 'number' ? raw : 30 * 60_000); // junk rides the clamp default
    }
    if (typeof patch.tunnelSessionTtlMs === 'number') controller.applySessionTtl(patch.tunnelSessionTtlMs);
  } catch {
    // wiring is best-effort; the next write retries
  }
}

/** §4.7 startup tunnel: NND brand of the OPENCHAMBER_TUNNEL_* family —
 * provider/mode gate the request; absent both means "no startup tunnel".
 * Whitespace-in-token and similar validation errors fail via the shared
 * normalizer at start time (never aborting boot). */
export function readEnvTunnelRequest(): Record<string, unknown> | null {
  const provider = (process.env.NOTNATIVE_TUNNEL_PROVIDER ?? '').trim();
  const mode = (process.env.NOTNATIVE_TUNNEL_MODE ?? '').trim();
  if (provider === '' && mode === '') return null;
  const request: Record<string, unknown> = {};
  if (provider !== '') request.provider = provider;
  if (mode !== '') request.mode = mode;
  const hostname = (process.env.NOTNATIVE_TUNNEL_HOSTNAME ?? '').trim();
  if (hostname !== '') request.hostname = hostname;
  const token = process.env.NOTNATIVE_TUNNEL_TOKEN;
  if (token !== undefined && token !== '') request.token = token;
  const configPath = process.env.NOTNATIVE_TUNNEL_CONFIG_PATH;
  if (configPath !== undefined && configPath !== '') {
    request.configPath = configPath; // `~/…` forms ride the shared resolver
  }
  return request;
}
