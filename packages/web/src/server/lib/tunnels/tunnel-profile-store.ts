// SPDX-License-Identifier: Apache-2.0
/**
 * Managed-remote profile store (doc 08 §4.4): `<data-dir>/cloudflare-
 * managed-remote-tunnels.json` (migrated from the legacy
 * `cloudflare-named-tunnels.json` on first read; version 1; write mode
 * 0o600; a single promise-locked writer serializes updates). Every
 * read/write sanitizes entries (id, name, hostname, token; hostname
 * normalized, no wildcard; dedupe by id AND hostname, first wins). Tokens
 * never travel beyond this file and the resolver (§12.1): API responses
 * receive ids/names/hostnames only. A corrupt file is never healed
 * silently (E-08-23 posture): reads answer empty, writes refuse until the
 * operator overwrites via the upsert route (explicit healing).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

export interface ManagedRemoteProfile {
  id: string;
  name: string;
  hostname: string;
  token: string;
  updatedAt: number;
}

interface ProfileFileShape {
  version: 1;
  tunnels: ManagedRemoteProfile[];
}

export const MANAGED_REMOTE_STORE_FILE = 'cloudflare-managed-remote-tunnels.json';
export const LEGACY_NAMED_TUNNELS_FILE = 'cloudflare-named-tunnels.json';

export function managedRemoteStorePath(dataDir: string): string {
  return pathJoin(dataDir, MANAGED_REMOTE_STORE_FILE);
}

function parseFile(raw: unknown): ProfileFileShape | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) return null;
  if (!Array.isArray(doc.tunnels)) return null;
  return { version: 1, tunnels: doc.tunnels as ManagedRemoteProfile[] };
}

function normalizeProfileHostname(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  let host = value.trim().toLowerCase();
  try {
    host = new URL(host).hostname; // bare or URL-form input
  } catch {
    try {
      host = new URL(`https://${host}`).hostname;
    } catch {
      return null;
    }
  }
  if (host === '' || host.includes('*')) return null;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(host) || host.includes('..')) return null;
  return host;
}

function sanitizeEntry(raw: unknown, stamp: number): ManagedRemoteProfile | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const token = typeof entry.token === 'string' ? entry.token.trim() : '';
  const hostname = normalizeProfileHostname(entry.hostname);
  if (id === '' || name === '' || token === '' || hostname === null) return null;
  const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : stamp;
  return { id, name, hostname, token, updatedAt };
}

function sanitizeList(raw: ManagedRemoteProfile[], stamp: number): ManagedRemoteProfile[] {
  const out: ManagedRemoteProfile[] = [];
  const ids = new Set<string>();
  const hostnames = new Set<string>();
  for (const entry of raw) {
    const candidate = sanitizeEntry(entry, stamp);
    if (candidate === null) continue;
    if (ids.has(candidate.id) || hostnames.has(candidate.hostname)) continue;
    ids.add(candidate.id);
    hostnames.add(candidate.hostname);
    out.push(candidate);
  }
  return out;
}

export class ManagedRemoteProfileStore {
  private readonly dataDir: string;
  private corrupt: boolean = false;
  private writerChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** §4.4: legacy `cloudflare-named-tunnels.json` migrates on the FIRST
   * read (its file is kept in place; the new store received the sanitized
   * entries). */
  list(): ManagedRemoteProfile[] {
    this.migrateLegacyStore();
    const path = managedRemoteStorePath(this.dataDir);
    if (!existsSync(path)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.corrupt = true;
      return [];
    }
    const shape = parseFile(raw);
    if (shape === null) {
      this.corrupt = true;
      return [];
    }
    this.corrupt = false; // an externally healed/valid file re-arms the store
    return sanitizeList(shape.tunnels, Date.now());
  }

  isCorrupt(): boolean {
    this.list(); // the latch is set by the read
    return this.corrupt;
  }

  /** Token-echo-free status view (§12.1). */
  view(): Array<{ id: string; name: string; hostname: string }> {
    return this.list().map((entry) => ({ id: entry.id, name: entry.name, hostname: entry.hostname }));
  }

  hasToken(): boolean {
    return this.list().some((entry) => entry.token !== '');
  }

  /** Removes entries conflicting with the new id OR hostname, then appends
   * (§4.4). This is also the corruption-healing path (explicit write).
   * Hostname validity is the caller's contract; a non-normalizable value
   * refuses. */
  async upsert(input: { id: string; name: string; hostname: string; token: string }): Promise<void> {
    const normalized = normalizeProfileHostname(input.hostname);
    if (normalized === null) throw new Error('invalid managed-remote tunnel hostname');
    if (typeof input.id !== 'string' || input.id.trim() === '') throw new Error('invalid managed-remote profile id');
    await this.enqueue(() => {
      const stamp = Date.now();
      const current = this.corrupt ? [] : this.list();
      const kept = current.filter((entry) => entry.id !== input.id && entry.hostname !== normalized);
      this.corrupt = false;
      this.writeStore([...kept, { id: input.id.trim(), name: input.name.trim(), hostname: normalized, token: input.token, updatedAt: stamp }], stamp);
    });
  }

  /** §4.4 resolveManagedRemoteTunnelToken: presetId first, then hostname,
   * else '' (settings fallback rides at the RESOLUTION CALLER). */
  resolveToken(input: { presetId?: string | null; hostname?: string | null }): string {
    const profiles = this.list();
    if (typeof input.presetId === 'string' && input.presetId !== '') {
      const byId = profiles.find((entry) => entry.id === input.presetId);
      if (byId !== undefined) return byId.token;
    }
    if (typeof input.hostname === 'string' && input.hostname !== '') {
      const normalized = normalizeProfileHostname(input.hostname);
      const byHost = profiles.find((entry) => entry.hostname === normalized);
      if (byHost !== undefined) return byHost.token;
    }
    return '';
  }

  /** §4.4 syncManagedRemoteTunnelConfigWithPresets: keeps only entries
   * whose id or hostname matches one of the given presets (doc-14 preset
   * import calls this). */
  async syncWithPresets(presets: ReadonlyArray<{ id: string; hostname: string }>): Promise<void> {
    await this.enqueue(() => {
      if (this.corrupt) return;
      const stamp = Date.now();
      const current = this.list();
      const kept = current.filter((entry) => presets.some(
        (preset) => preset.id === entry.id || (normalizeProfileHostname(preset.hostname) ?? '') === entry.hostname,
      ));
      this.writeStore(sanitizeList(kept, stamp), stamp);
    });
  }

  private async enqueue(work: () => void): Promise<void> {
    const previous = this.writerChain;
    this.writerChain = previous.then(work, work);
    await this.writerChain;
  }

  private writeStore(tunnels: ManagedRemoteProfile[], _stamp: number): void {
    const path = managedRemoteStorePath(this.dataDir);
    const shape: ProfileFileShape = { version: 1, tunnels };
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(shape, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  }

  private migrateLegacyStore(): void {
    const legacyPath = pathJoin(this.dataDir, LEGACY_NAMED_TUNNELS_FILE);
    if (!existsSync(legacyPath)) return;
    if (existsSync(managedRemoteStorePath(this.dataDir))) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(legacyPath, 'utf8'));
    } catch {
      return; // unreadable legacy: the new store seeds empty (never invent tokens)
    }
    const shape = parseFile(raw);
    if (shape === null) return;
    const stamp = Date.now();
    this.writeStore(sanitizeList(shape.tunnels, stamp), stamp);
  }
}

let singleton: ManagedRemoteProfileStore | null = null;

/** First-caller options win (the relay/pairing singleton convention): the
 * composition root passes the data dir; late callers reuse the instance. */
export function getManagedRemoteProfileStore(options?: { dataDir?: string }): ManagedRemoteProfileStore {
  if (singleton === null) {
    const dataDir = options?.dataDir;
    if (typeof dataDir !== 'string' || dataDir === '') {
      throw new Error('getManagedRemoteProfileStore requires a dataDir on first call');
    }
    singleton = new ManagedRemoteProfileStore(dataDir);
  }
  return singleton;
}

export function resetManagedRemoteProfileStoreForTests(): void {
  singleton = null;
}
