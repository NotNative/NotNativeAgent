// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host configuration store (doc 08 §3.12 + §11.2): the demand-driven
 * lifecycle authors `privateRelay = {enabled, relayUrl}`. NND keeps those
 * two machine-managed values in a dedicated dataDir file
 * `<data-dir>/relay-config.json` (E-08-28: settings-registry relay keys have
 * not landed yet; dedicated-file posture mirrors E-08-23) with 0600 atomic
 * tmp+rename writes and a strict reader. A corrupt file is never repaired and
 * never re-enabled: the lifecycle refuses to run, and reconcile aborts rather
 * than faking "no demand" (§3.12 store-read discipline).
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { DEFAULT_BATCH_WINDOW_MS } from './batch.ts';

/** §3.1: default relay endpoint; §11.1: `NOTNATIVE_RELAY_URL` pins it. */
export const DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws';
/** §3.15 enable-body budget (16 KB limit on the JSON body). */
export const RELAY_ENABLE_BODY_MAX_BYTES = 16 * 1024;

export interface RelayConfig {
  enabled: boolean;
  relayUrl: string | null;
  /** true = the on-disk file exists but is corrupt/mis-shaped; the service
   * refuses lifecycle mutations until an operator heals the file. */
  corrupt: boolean;
}

interface RelayConfigFileShape {
  version: 1;
  enabled: boolean;
  relayUrl: string | null;
}

export function relayConfigPath(dataDir: string): string {
  return joinPath(dataDir, 'relay-config.json');
}

function isWsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && value.toLowerCase().startsWith('ws');
  } catch {
    return false;
  }
}

function parseConfigFile(raw: unknown): RelayConfigFileShape | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) return null;
  if (typeof doc.enabled !== 'boolean') return null;
  if (doc.relayUrl !== null && !isWsUrl(doc.relayUrl)) return null;
  return { version: 1, enabled: doc.enabled, relayUrl: typeof doc.relayUrl === 'string' ? doc.relayUrl : null };
}

function readConfigFile(dataDir: string): { shape: RelayConfigFileShape | null; present: boolean } {
  const path = relayConfigPath(dataDir);
  if (!existsSync(path)) return { shape: null, present: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { shape: null, present: true }; // unparsable presence = corrupt
  }
  const shape = parseConfigFile(raw);
  return { shape, present: shape === null };
}

function writeConfigFile(dataDir: string, shape: RelayConfigFileShape): void {
  mkdirSync(dataDir, { recursive: true });
  const path = relayConfigPath(dataDir);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(shape, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export class RelayConfigStore {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  read(): RelayConfig {
    const { shape, present } = readConfigFile(this.dataDir);
    if (present) {
      // corrupt presence: hard-refuse (never heal, never fake disabled-demand)
      return { enabled: false, relayUrl: null, corrupt: true };
    }
    return { enabled: shape?.enabled ?? false, relayUrl: shape?.relayUrl ?? null, corrupt: false };
  }

  /** Persists an absolute config (machine-managed values, not user-authored). */
  write(config: { enabled: boolean; relayUrl: string | null }): void {
    const current = this.read();
    if (current.corrupt) throw new Error('relay config file is corrupt; refusing to write');
    writeConfigFile(this.dataDir, { version: 1, enabled: config.enabled, relayUrl: config.relayUrl });
  }
}

// ---- environment resolution (§11.1 relay rows) -------------------------------

/** NOTNATIVE_RELAY_URL: pins the relay endpoint (overrides the stored
 * setting for host dial, pairing candidates, status). Invalid values fall
 * through to the stored/default chain rather than breaking boot. */
export function readEnvRelayUrl(): string | null {
  const value = process.env.NOTNATIVE_RELAY_URL;
  return isWsUrl(value) ? (value as string) : null;
}

/** Env override authoritativity → status.relayUrlLocked. */
export function relayUrlLocked(): boolean {
  return readEnvRelayUrl() !== null;
}

/** Passive-host hold-out (§3.12): `NOTNATIVE_RELAY_HOST=off` (or the dev
 * shell `NOTNATIVE_ELECTRON_DEV`) makes the instance never host on boot,
 * demand, or watcher takeover; `NOTNATIVE_RELAY_HOST=on` overrides both.
 * Explicit enable/pairing (force-claim) may still host there. */
export function readRelayHostHoldOut(): boolean {
  const mode = process.env.NOTNATIVE_RELAY_HOST;
  if (mode === 'on') return false;
  if (mode === 'off') return true;
  return process.env.NOTNATIVE_ELECTRON_DEV === '1';
}

/** Endpoint resolution chain (§5.5 relay candidate): env override → stored
 * `relayUrl` → default endpoint. Non-ws stored values never resolve. */
export function resolveRelayUrl(config: RelayConfig): string {
  return readEnvRelayUrl() ?? (config.relayUrl !== null ? config.relayUrl : DEFAULT_RELAY_URL);
}

/** §3.15 enable normalization: ws/wss kept; anything else (absent, http,
 * junk) falls back to the default endpoint rather than persisting junk. */
export function normalizeRelayUrl(input: unknown): string {
  return isWsUrl(input) ? (input as string) : DEFAULT_RELAY_URL;
}

/** §3.6 batching window env override (`OPENCHAMBER_RELAY_BATCH_WINDOW_MS`
 * in the reference — NND reads the NOTNATIVE_ brand of the same pick);
 * invalid values keep the 150 ms default, clamped 1..5000. */
export function readEnvBatchWindowMs(): number {
  const raw = process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS;
  if (raw === undefined || raw.length === 0) return DEFAULT_BATCH_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_BATCH_WINDOW_MS;
  return Math.min(5000, Math.max(1, Math.round(parsed)));
}
