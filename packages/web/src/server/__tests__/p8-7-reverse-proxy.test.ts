// SPDX-License-Identifier: Apache-2.0
/**
 * P8-7 reverse-proxy posture gates (doc 08 section 9, checklist step 14):
 * origin consumption (host equality only, x-forwarded-host/publicOrigin
 * candidates, packaged-client origins, absent origin passes, bracketed
 * IPv6 and WHATWG port canonicalization on every candidate), the terminal
 * WS upgrade origin gate over a real loopback server (the §3.9 dialer
 * posture, the edge-TLS x-forwarded-host hop, doubled Origin headers that
 * must fail closed, bracketed-Host parity), robots hygiene on every
 * response incl. streamed SSE and the hono onError belt, and the shipped
 * SSE no-buffering headers (a stream refactor must not silently re-buffer
 * SSE behind a proxy). Cookie Secure (x-forwarded-proto), passkey rpID
 * (x-forwarded-host) and the redeem limiter's raw-socket keying were
 * sealed in P8-1b/1c/1d/4a and are pinned by their own suites.
 */
import './helpers/env-boot.ts'; // must stay FIRST: data dir fixed before the env snapshot boot
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { WebSocket } from 'ws';

import { Hono } from 'hono';
import { originAdmittedByHeaders, originHostPasses } from '../lib/http/request-security.ts';
import { attachTerminalWebsocket } from '../terminal/wire.ts';
import { TerminalRuntime } from '../terminal/session-core.ts';
import type { PtyFactory } from '../terminal/pty-backend.ts';
import type { Hono as HonoType } from 'hono';

const HELLO_WAIT_MS = 1_500;
const RAW_TIMEOUT_MS = 5_000;

/** Raw-socket handshake skeleton: only the Host/Origin lines vary per case. */
const WS_HANDSHAKE_HEAD = [
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
];

/** Gate tests never spawn a PTY: the factory throws loudly if any path tried. */
const neverSpawnFactory = (): PtyFactory => (): never => {
  throw new Error('gate tests never spawn a PTY');
};

type RawVerdict = 'upgraded' | 'refused';

/** One raw HTTP upgrade probe; only the handshake line list varies. */
function rawUpgrade(port: number, headerLines: string[]): Promise<RawVerdict> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(['GET /api/terminal/ws HTTP/1.1', ...headerLines, '', ''].join('\r\n'));
    });
    let text = '';
    let settled = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      text += chunk;
      if (text.includes('101')) settle('upgraded');
    });
    socket.on('close', () => settle(text.includes('101') ? 'upgraded' : 'refused'));
    socket.on('error', () => settle('refused'));
    const timer = setTimeout(() => settle('refused'), RAW_TIMEOUT_MS);
    function settle(result: RawVerdict): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }
  });
}

describe('section 9 origin consumption (host equality only)', () => {
  it('origin host equality passes for host/x-forwarded-host/publicOrigin candidates', () => {
    expect(originHostPasses({ origin: 'https://my.tunnel.app', host: 'my.tunnel.app' })).toBe(true);
    expect(originHostPasses({ origin: 'http://hop.local:3000', host: 'rewritten.internal' }, 'http://hop.local:3000')).toBe(true);
    expect(originAdmittedByHeaders(
      { originHeader: 'https://my.tunnel.app', hostHeader: 'rewritten.internal:3000', forwardedHostHeader: 'my.tunnel.app' },
    )).toBe(true);
    expect(originHostPasses({ origin: 'https://evil.example', host: 'my.tunnel.app' })).toBe(false);
    expect(originHostPasses({ origin: 'https://my.tunnel.app:8443', host: 'my.tunnel.app' })).toBe(false);
  });

  it('protocol never compares: the edge-terminated https origin passes on an http Host', () => {
    expect(originHostPasses({ origin: 'https://my.tunnel.app', host: 'http://my.tunnel.app' })).toBe(true);
    expect(originAdmittedByHeaders({
      originHeader: 'https://my.tunnel.app',
      hostHeader: 'my.tunnel.app:443',
      forwardedHostHeader: null,
    })).toBe(true);
  });

  it('bracketed IPv6 literals compare on both sides (the pre-fix regex answered null forever)', () => {
    expect(originHostPasses({ origin: 'http://[::1]:4090', host: '[::1]:4090' })).toBe(true);
    expect(originHostPasses({ origin: 'https://[::1]:443', host: '[::1]' })).toBe(true); // WHATWG strips the scheme default
    expect(originHostPasses({ origin: '[::1]', host: '[::1]' })).toBe(true); // bare IPv6 shape rides the same arm
    expect(originHostPasses({ origin: 'http://[fe80::1]:8080', host: '[fe80::1]:8080' })).toBe(true);
    expect(originHostPasses({ origin: 'http://[::1]:4090', host: '127.0.0.1:4090' })).toBe(false); // IPv6 vs IPv4 stays distinct
    expect(originHostPasses({ origin: 'fe80::1', host: 'fe80::1' })).toBe(false); // unbracketed junk fails closed
  });

  it('the port canonicalizes like WHATWG across the whole candidate set', () => {
    expect(originHostPasses({ origin: 'http://my.tunnel.app:080', host: 'my.tunnel.app:080' })).toBe(true);
    expect(originHostPasses({ origin: 'http://hop:08080', host: 'hop:08080' })).toBe(true); // both sides render :08080 == :8080
    expect(originHostPasses({ origin: 'https://hop', host: 'hop:443' })).toBe(true); // bare :443 drops (edge-terminated hop)
    expect(originHostPasses({ origin: 'http://hop:80', host: 'hop' })).toBe(true);
    expect(originHostPasses({ origin: 'https://hop:4430', host: 'hop' })).toBe(false); // real ports stay part of the host
    expect(originHostPasses({ origin: 'http://hop:08080', host: 'hop:8081' })).toBe(false); // canonical then distinct ports never merge
  });

  it('the packaged-client origins ride pre-allowed (case-folded)', () => {
    for (const origin of ['openchamber-ui://app', 'capacitor://localhost', 'https://localhost', 'http://localhost']) {
      expect(originHostPasses({ origin, host: 'other.host.example' })).toBe(true);
      expect(originHostPasses({ origin: origin.toUpperCase(), host: 'other.host.example' })).toBe(true);
    }
  });

  it('absent Origin passes; junk Origin fails closed', () => {
    expect(originHostPasses({ origin: null, host: 'my.tunnel.app' })).toBe(true);
    expect(originHostPasses({ origin: '  ', host: 'my.tunnel.app' })).toBe(true);
    expect(originHostPasses({ origin: 'https://my.tunnel.app', host: null, forwardedHost: null })).toBe(false);
    expect(originHostPasses({ origin: 'javascript:alert(1)', host: 'my.tunnel.app' })).toBe(false);
    expect(originHostPasses({ origin: 'https://my.tunnel.app', host: 'my.tunnel.app, www.tunnel.app' })).toBe(false);
    // host-only rule consequence (E-08-65): a schemeless bare-host origin
    // compares equal to its own host - browsers never emit that shape, and
    // non-browser clients are not origin-bound anyway
    expect(originHostPasses({ origin: 'my.tunnel.app', host: 'my.tunnel.app' })).toBe(true);
  });
});

/** The real upgrade gate over a REAL loopback http server (no PTY spawn:
 *  a throwing factory fails loudly if any code path ever tried). Covers the
 *  ws-dial cases (absent origin, §3.9 dialer posture, edge-TLS hop, foreign
 *  origin) and the raw-socket cases the ws client cannot produce (doubled
 *  Origin header, bracketed IPv6 Host/Origin parity). */
describe('terminal WS upgrade origin gate (doc 08 section 9, wire.ts)', () => {
  let server: http.Server | null = null;
  let wiring: { dispose(): void } | null = null;
  let runtime: TerminalRuntime | null = null;
  let port = 0;

  beforeAll(async () => {
    runtime = new TerminalRuntime(neverSpawnFactory());
    server = http.createServer();
    server.listen(0, '127.0.0.1');
    wiring = attachTerminalWebsocket(server, runtime!);
    await new Promise<void>((resolvePromise) => server!.once('listening', resolvePromise));
    port = (server!.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    wiring?.dispose();
    runtime?.dispose();
    await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()));
  });

  function dialsWith(headers: Record<string, string>): { socket: WebSocket; open: Promise<void>; messages: Buffer[] } {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers });
    const messages: Buffer[] = [];
    const open = new Promise<void>((resolvePromise, rejectPromise) => {
      socket.once('open', () => resolvePromise());
      socket.once('error', (error: Error) => rejectPromise(error));
    });
    socket.on('message', (data: Buffer) => messages.push(data));
    return { socket, open, messages };
  }

  async function firstHello(messages: Buffer[]): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < HELLO_WAIT_MS / 50 && messages.length === 0; attempt += 1) {
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(messages.length).toBeGreaterThan(0); // a silent open is a gate failure, not a hang
    return JSON.parse(messages[0]!.subarray(1).toString('utf8')) as Record<string, unknown>;
  }

  it('absent Origin passes through (same-origin dials and non-browser clients omit it)', { timeout: 10_000 }, async () => {
    const { socket, open, messages } = dialsWith({});
    await open;
    expect(await firstHello(messages)).toMatchObject({ v: 3, t: 'hello' });
    socket.close();
  });

  it('the §3.9 dialer posture passes: Origin = the loopback dial url equals the Host header', { timeout: 10_000 }, async () => {
    const { socket, open, messages } = dialsWith({ origin: `http://127.0.0.1:${port}` });
    await open;
    expect(await firstHello(messages)).toMatchObject({ v: 3, t: 'hello' });
    socket.close();
  });

  it('TLS-terminated-at-edge hop passes via x-forwarded-host against the rewritten internal Host', { timeout: 10_000 }, async () => {
    const { socket, open, messages } = dialsWith({ origin: 'https://my.tunnel.app', host: 'rewritten.internal:3000', 'x-forwarded-host': 'my.tunnel.app' });
    await open;
    expect(await firstHello(messages)).toMatchObject({ v: 3, t: 'hello' });
    socket.close();
  });

  it('a foreign Origin is destroyed even though the peer is loopback (fail closed)', { timeout: 10_000 }, async () => {
    const { socket, open } = dialsWith({ origin: 'https://evil.example' });
    await expect(open).rejects.toThrow(); // destroyed socket -> the upgrade never completes
    socket.terminate();
  });

  it('a DOUBLED Origin header fails closed (joined, never silently dropped to absent)', { timeout: 10_000 }, async () => {
    const verdict = await rawUpgrade(port, [
      `Host: 127.0.0.1:${port}`,
      ...WS_HANDSHAKE_HEAD,
      `Origin: http://127.0.0.1:${port}`,
      `Origin: http://127.0.0.1:${port}`,
    ]);
    expect(verdict).toBe('refused'); // 'a, b' parses as no origin: the gate must not read this as absent
  });

  it('bracketed IPv6 Host/Origin parity upgrades (443 stripped on both sides)', { timeout: 10_000 }, async () => {
    const verdict = await rawUpgrade(port, ['Host: [::1]:443', ...WS_HANDSHAKE_HEAD, 'Origin: https://[::1]:443']);
    expect(verdict).toBe('upgraded');
  });

  it('bracketed IPv6 with a foreign origin stays refused', { timeout: 10_000 }, async () => {
    const verdict = await rawUpgrade(port, ['Host: [::1]:443', ...WS_HANDSHAKE_HEAD, 'Origin: https://[fe80::1]:443']);
    expect(verdict).toBe('refused');
  });
});

describe('section 9 public-instance hygiene (robots + sse headers)', () => {
  let app: HonoType | null = null;

  it('/robots.txt answers disallow-all before any gate', async () => {
    app = (await import('../app.ts')).createApp();
    const response = await app.request('/robots.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('Disallow: /');
  });

  it('every response carries X-Robots-Tag noindex, nofollow', async () => {
    app = (await import('../app.ts')).createApp();
    const health = await app.request('/health');
    expect(health.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const missing = await app.request('/definitely/not/here');
    expect(missing.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const robots = await app.request('/robots.txt');
    expect(robots.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const terminal401 = await app.request('/auth/session');
    expect(terminal401.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('stamps through a STREAMED SSE surface (not just finalized JSON answers)', { timeout: 15_000 }, async () => {
    app = (await import('../app.ts')).createApp();
    const stream = await app.request('/api/notnative/events');
    expect(stream.status).toBe(200);
    expect(stream.headers.get('x-robots-tag')).toBe('noindex, nofollow'); // the c.res clone carried the tag onto a stream body
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.headers.get('content-type')).toBe('text/event-stream'); // the clone never clobbers sse.ts headers
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(first.value !== undefined && new TextDecoder().decode(first.value).includes(': open')).toBe(true);
    await reader.cancel(); // the unsubscribe cleanup owns the rest
  });

  it('the harness crash answer (502) carries the tag', async () => {
    const { registerHarnessAdapter } = await import('../harness/adapter.ts');
    registerHarnessAdapter({ handle: () => Promise.reject(new Error('gate crash')) });
    app = (await import('../app.ts')).createApp();
    const response = await app.request('/api/experimental/session');
    expect(response.status).toBe(502);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('the hono onError belt stamps a throwing route through real machinery', async () => {
    const { errorHygiene, registerPublicHygiene } = await import('../app.ts');
    const probe = new Hono();
    registerPublicHygiene(probe);
    probe.onError(errorHygiene);
    probe.get('/throwing', () => {
      throw new Error('boom');
    });
    const response = await probe.request('/throwing');
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('seeded SSE posture stays un-buffered (section 9 pin)', () => {
  it('sseResponse sets no-cache, no-transform + x-accel-buffering: no', async () => {
    const { sseResponse } = await import('../lib/sse.ts');
    const response = sseResponse(() => () => undefined);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });
});
