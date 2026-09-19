// SPDX-License-Identifier: Apache-2.0
/**
 * Server-side pairing candidate construction (doc 08 sections 5.5/6.1,
 * refresh in section 3.13): direct = caller-supplied serverUrl otherwise
 * the request origin (loopback origins are never auto-advertised), an
 * extra direct candidate for the creator's browsing origin (priority 20)
 * when it differs and is not loopback, relay last (30) when enabled. All
 * URL candidates strip hash + trailing "/" runs and stay http(s). Type
 * mirrors the CLI parity rule: https -> tunnel, http -> lan.
 */
import os from 'node:os';
import { PRIORITY_DIRECT_ORIGIN, PRIORITY_DIRECT_PRIMARY, type PairingCandidate } from './pairing-payload.ts';

export const LOOPBACK_HOSTNAMES = new Set([
  '127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', '0000:0:0:0:0:0:0:1',
]);

export function serverLabel(): string {
  return os.hostname();
}

/** First non-internal IPv4 from the interface scan; null on scan failure
 * or loopback-only hosts (an empty LAN list must not erase client-side
 * stored addresses, section 3.13). */
export function lanIpv4FromInterfaces(): string | null {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const entries = interfaces[name] ?? [];
      for (const entry of entries) {
        if (entry.family !== 'IPv4' || entry.internal !== false) continue;
        if (typeof entry.address === 'string' && entry.address !== '') return entry.address;
      }
    }
  } catch {
    return null; // scan failure: no LAN candidate, never a wrong one
  }
  return null;
}

export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return LOOPBACK_HOSTNAMES.has(bare);
}

export function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** http/https only; hash stripped; trailing "/" runs stripped (section 5.2);
 * wildcard bind names (0.0.0.0/::) are unrenderable for a device and never
 * an advertised candidate. */
export function normalizeDirectUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.split('#')[0]!.trim();
  if (!/^https?:\/\//iu.test(cleaned)) return null;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (hostname === '0.0.0.0' || hostname === '::' || hostname === '0000:0000:0000:0000:0000:0000:0000:0000') return null;
  return cleaned.replace(/\/+$/u, '');
}

function directCandidate(urlStr: string, priority: number): PairingCandidate {
  return {
    type: urlStr.startsWith('https://') ? 'tunnel' : 'lan',
    url: urlStr,
    priority,
  };
}

/** section 5.5 candidate math. primary: serverUrl (validated) else the
 * request origin; the auto fallback (unlike an explicit serverUrl) is
 * never a loopback origin. Extra direct: the creator's browsing origin
 * when it differs from the primary and is not loopback (priority 20). */
export function buildSessionServerCandidates(input: {
  serverUrl?: unknown;
  requestOrigin?: string | null;
}): PairingCandidate[] {
  const candidates: PairingCandidate[] = [];
  const preferred = normalizeDirectUrl(input.serverUrl);
  const origin = typeof input.requestOrigin === 'string' && input.requestOrigin !== '' ? input.requestOrigin : null;
  if (preferred !== null) candidates.push(directCandidate(preferred, PRIORITY_DIRECT_PRIMARY));
  else if (origin !== null && !isLoopbackUrl(origin)) candidates.push(directCandidate(origin, PRIORITY_DIRECT_PRIMARY));
  if (origin === null) return candidates;
  const primaryUrl = preferred ?? (isLoopbackUrl(origin) ? null : origin);
  if (primaryUrl !== null && origin !== primaryUrl && !isLoopbackUrl(origin)) {
    candidates.push(directCandidate(origin, PRIORITY_DIRECT_ORIGIN));
  }
  return dedupeUrlCandidates(candidates);
}

/** section 3.13 refresh: the client-reached address first (the socket's
 * local side — what the device actually hit), then the interface scan;
 * loopback reached-addresses are excluded, relays ride last (30). */
export function buildRefreshLanCandidates(input: { reachedUrl?: string | null; scannedLan?: string | null; port?: number }): PairingCandidate[] {
  const candidates: PairingCandidate[] = [];
  const seen = new Set<string>();
  for (const urlStr of [input.reachedUrl, input.scannedLan]) {
    if (typeof urlStr !== 'string' || urlStr === '' || isLoopbackUrl(urlStr)) continue;
    if (seen.has(urlStr)) continue;
    seen.add(urlStr);
    candidates.push(directCandidate(urlStr, PRIORITY_DIRECT_PRIMARY));
  }
  return candidates;
}

/** section 5.5 row: {local, lan} for the transport chooser — LAN derives
 * from the server BIND, not the UI origin (section 6.1 step 1/2). */
export function serverTransports(input: { host: string; port: number }): { local: string; lan: string | null } {
  const lan = transferLanFromBind(input.host, input.port);
  return { local: `http://127.0.0.1:${input.port}`, lan };
}

function transferLanFromBind(host: string, port: number): string | null {
  const normalized = (host || '').trim().toLowerCase();
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '') {
    const scanned = lanIpv4FromInterfaces();
    return scanned === null ? null : `http://${scanned}:${port}`;
  }
  if (isLoopbackHostname(normalized)) return null; // loopback-only bind: no LAN URL exists
  return `http://${normalized}:${port}`;
}

/** Stable append-only dedupe: the client candidates carry priority as
 * advisory ordering (section 5.7); the relay candidate appends LAST. */
export function dedupeUrlCandidates(candidates: PairingCandidate[]): PairingCandidate[] {
  const seen = new Set<string>();
  const out: PairingCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.type === 'relay' ? `relay:${candidate.relayUrl}` : candidate.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}
