// SPDX-License-Identifier: Apache-2.0
/**
 * P8-8 invariants sweep (checklist step 15): §12 re-audit as a pinned
 * checklist. Static audit rows read the shipped source as invariants —
 * (a) no raw Authorization/cookie-header logging anywhere in server src
 * (comments excluded), (b) every secret-bearing store write carries
 * mode 0o600 (relay-host.lock's 0o644 is the registered non-secret
 * exception, E-08-29), (c) every client-auth route answers through the
 * single no-store json() helper, (d) tunnel route bodies never echo the
 * managed-remote run token (the /connect?t= bootstrap link is the one
 * sanctioned seat), (e) the ui runtime/relay files carry no persistence
 * APIs, so the §12.3 grant/URL-token never leaves memory by construction.
 * Runtime pins cover the §12.5 single-tenant row one host-data leg per
 * client connection (duplicate announcements stay ONE dial) and the
 * §12.1 failChannel row (leg failure reasons never carry payload bytes).
 * Full §12 matrix: docs/planning/NOTES/08-remote-access-and-security.md §D.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { join as joinPath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { RelayIdentityStore, type RelayRole } from '../lib/relay/identity.ts';
import { RelayHostBroker, type RelayHostTiming } from '../lib/relay/host-broker.ts';
import { createRelayLegHost, type RelayLegHost } from '../lib/relay/leg-host.ts';
import { closeAllFakeWorkers, createFakeWorker, type FakeWorker } from './helpers/relay-fake-worker.ts';

// URL arithmetic from this FILE: each '..' pops the implicit file segment
// first, so '../' → src/server, '../../../../../ui/src/lib' → the ui lib.
const SERVER_DIR = fileURLToPath(new URL('../', import.meta.url));
const UI_LIB_DIR = fileURLToPath(new URL('../../../../ui/src/lib', import.meta.url));

function serverSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const path = joinPath(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(SERVER_DIR);
  return files;
}

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
};

const LOG_CALL = /console\.(?:log|warn|error|info|debug)|\blogger\.(?:log|warn|error|info|debug)/;

describe('P8-8 static invariants (§12 re-audit)', () => {
  it('§12.1(a): no console/logger statement line in server src mentions authorization or cookie headers', () => {
    const violations: string[] = [];
    for (const file of serverSourceFiles()) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (isCommentLine(line)) continue;
        if (LOG_CALL.test(line) && /authorization|cookie/i.test(line)) violations.push(`${file}: ${line.trim()}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('§12.2(b): every secret-bearing store write carries mode 0o600; host-lock stays the 0o644 exception (E-08-29)', () => {
    const secretStores = [
      '../lib/settings-store.ts',
      '../lib/relay/identity.ts',
      '../lib/relay/relay-config.ts',
      '../lib/auth/pairing-sessions.ts',
      '../lib/auth/remote-clients.ts',
      '../lib/auth/jwt.ts',
      '../lib/auth/ui-passkeys.ts',
      '../lib/tunnels/tunnel-profile-store.ts',
      '../lib/tunnels/cloudflare-managed.ts', // the §12.1 managed-remote token temp file
    ];
    const violations: string[] = [];
    for (const relative of secretStores) {
      const file = fileURLToPath(new URL(relative, import.meta.url));
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      const writes = lines.map((line, index) => ({ line, index }))
        .filter(({ line }) => /writeFileSync\(/.test(line) && !isCommentLine(line));
      expect(writes, `${relative} has no write site`).not.toHaveLength(0);
      for (const { line, index } of writes) {
        if (!/mode:\s*0o600/.test(line)) violations.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
    const lockFile = fileURLToPath(new URL('../lib/relay/host-lock.ts', import.meta.url));
    const lockWrites = readFileSync(lockFile, 'utf8').split(/\r?\n/)
      .filter((line) => /writeFileSync\(/.test(line) && !isCommentLine(line));
    expect(lockWrites.every((line) => /mode:\s*0o644/.test(line)), 'relay-host.lock pins 0o644 (pid+timestamp, non-secret; E-08-29)').toBe(true);
  });

  it('§12.1(c): every client-auth route answer flows through the single no-store json() helper', () => {
    const file = fileURLToPath(new URL('../routes/client-auth.ts', import.meta.url));
    const src = readFileSync(file, 'utf8');
    expect(src.match(/new Response\(/g)).toHaveLength(1); // only the shared helper constructs responses
    const helper = src.slice(src.indexOf('function json(status'), src.indexOf('function principalOf'));
    expect(helper).toContain("'cache-control': 'no-store'");
    // the redeem (pre-gate registrar) and the gated create/revoke/purge/cancel
    // family share the helper; create/redeem no-store + 429 no-store are
    // pinned at runtime by p8-4a-client-auth-routes.
  });

  it('§12.1(d): tunnel route bodies never surface the run token; the one-time /connect seat is the only token-bearing view', () => {
    const file = fileURLToPath(new URL('../routes/tunnel.ts', import.meta.url));
    const src = readFileSync(file, 'utf8');
    const violations: string[] = [];
    for (const [index, line] of src.split(/\r?\n/).entries()) {
      if (isCommentLine(line)) continue;
      if (!/jsonRoute\(/.test(line) || !/token/i.test(line)) continue;
      if (/connectUrl|bootstrapToken/.test(line)) continue; // §4.6 start response: sanctioned one-time bootstrap link
      if (/managedRemoteTunnelTokenPresetIds/.test(line)) continue; // §4.4 upsert view: preset IDS only, never the token values
      violations.push(`routes/tunnel.ts:${index + 1}: ${line.trim()}`);
    }
    expect(violations, violations.join('\n')).toEqual([]);
    // runtime lead: p8-4c-tunnel-profile-store '(§12.1)' + p8-4c-tunnel-routes
    // 'managed-remote-token upsert ... §12.1: tokens never echo' + the
    // doctor POST never-echo row.
  });

  it('§12.3(e): the ui runtime/relay files carry no persistence APIs (grant/URL-token cannot leave memory)', () => {
    const runtimeFiles = [
      'runtime-auth.ts',
      'runtime-auth-expiry.ts',
      'runtime-fetch.ts',
      'runtime-socket.ts',
      'runtime-switch.ts',
      'runtime-tunnel.ts',
      'runtime-url.ts',
      'runtimeConfig.ts',
      'runtimeSurface.ts',
      'relay/tunnel-client.ts',
    ];
    const violations: string[] = [];
    for (const relative of runtimeFiles) {
      const file = joinPath(UI_LIB_DIR, relative);
      let src: string;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        violations.push(`${relative}: missing from the ui tree`);
        continue;
      }
      for (const [index, line] of src.split(/\r?\n/).entries()) {
        if (isCommentLine(line)) continue;
        if (/localStorage|sessionStorage|indexedDB|caches\.open/.test(line)) violations.push(`ui/src/lib/${relative}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
    // the relay grant rides the §3.3 socket URL only (relay-primitives pins
    // the exact client-role URL shape); the one-time pairing secret exists
    // only in the create reply and the encoded link (p8-4a + dialog pins).
  });
});

const SUITE_TIMING: RelayHostTiming = {
  controlPingMs: 1000,
  controlPongGraceMs: 500,
  dataOpenTimeoutMs: 4000,
  dataIdleMs: 60_000,
  dataSweepMs: 60_000,
  reconnectBaseMs: 50,
  reconnectCapMs: 200,
};

/** Wraps the identity store to count host-data dials without touching the broker. */
class CountingIdentity extends RelayIdentityStore {
  readonly hostDataDials: Array<{ connectionId: string; role: RelayRole }> = [];

  override async relaySocketUrl(
    baseUrl: string,
    role: RelayRole,
    ts: number,
    extra: { connectionId?: string; grant?: string; appId?: string; appVersion?: string; platform?: string } = {},
  ): Promise<string> {
    if (role === 'host-data') this.hostDataDials.push({ connectionId: extra.connectionId ?? '', role });
    return super.relaySocketUrl(baseUrl, role, ts, extra);
  }
}

describe('P8-8 runtime invariants (§12 single-tenant + failChannel rows)', () => {
  const brokers: RelayHostBroker[] = [];
  let workerInstance: FakeWorker | null = null;

  afterAll(async () => {
    for (const broker of brokers) broker.stop();
    await closeAllFakeWorkers();
  });

  it('§12.5: duplicate client announcements stay ONE host-data leg (the worker closes real dupes 4002)', async () => {
    const dir = mkdtempSync(`${tmpdir()}${sep}nnd-sweep-dup-`);
    const identity = new CountingIdentity(dir);
    workerInstance = await createFakeWorker();
    const closed: Array<[string, number, string]> = [];
    const established: string[] = [];
    const broker = new RelayHostBroker({
      identity,
      timing: SUITE_TIMING,
      onLegEstablished: (connectionId) => established.push(connectionId),
      onLegClosed: (connectionId, code, reason) => closed.push([connectionId, code, reason]),
    });
    brokers.push(broker);
    await broker.start({ relayUrl: workerInstance.url, platform: 'test' });
    await expect.poll(() => broker.getStatus().state === 'connected', { timeout: 2000, interval: 10 }).toBe(true);
    await expect.poll(() => workerInstance !== null && workerInstance.hostControl() !== null, { timeout: 2000, interval: 10 }).toBe(true);
    const clientUrl = `${workerInstance.url}?v=1&role=client&appId=test&serverId=${await identity.serverId()}&connectionId=leg-dup`;
    const client = new WebSocket(clientUrl);
    await new Promise<void>((resolve, rejectOpen) => { client.once('open', () => resolve()); client.once('error', rejectOpen); });
    const dials = (): number => identity.hostDataDials.filter((row) => row.connectionId === 'leg-dup').length;
    await expect.poll(dials, { timeout: 2000, interval: 10 }).toBe(1); // the natural announce dialed exactly once and registered
    // duplicate announcements for the SAME connection may never widen the leg set
    workerInstance.announceConnected('leg-dup');
    workerInstance.announceConnected('leg-dup');
    workerInstance.announceSync(['leg-dup', 'leg-dup']);
    await new Promise((resolve) => setTimeout(resolve, 80)); // beyond the async dial chain (sign → socket → legs.set)
    expect(dials()).toBe(1);
    expect(broker.getStatus().connectedClients).toBe(1);
    expect(established.filter((id) => id === 'leg-dup')).toEqual([]); // no real handshake was joined
    expect(closed).toEqual([]);
    client.close();
  });

  it('§12.1: the leg failChannel carries structural reasons only — never payload bytes', async () => {
    const reasons: string[] = [];
    let leg: RelayLegHost | null = createRelayLegHost({
      connectionId: 'leg-sentinel',
      localPort: 4090,
      send: () => undefined,
      onChannelFailure: (reason) => { reasons.push(reason); },
      capabilities: { batch: false, flowControl: false },
    });
    const sentinel = 'SENTINEL-PAYLOAD-BYTES-Q7-leak';
    leg.acceptPlaintext(Buffer.concat([Buffer.from('7f', 'hex'), Buffer.from(sentinel, 'utf8')]));
    await expect.poll(() => reasons.length, { timeout: 2000, interval: 10 }).toBeGreaterThan(0);
    leg.dispose();
    leg = null;
    expect(reasons[0]!).toContain('relay tunnel framing violated'); // §3.6 foreign numeral = CodecError (fail closed)
    expect(reasons[0]!).not.toContain(sentinel);
    expect(reasons[0]!.length).toBeLessThan(200);
  });
});
