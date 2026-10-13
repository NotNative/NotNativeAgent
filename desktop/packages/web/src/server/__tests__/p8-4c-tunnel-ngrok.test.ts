// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4c gates part 4: the ngrok quick driver (§4.3) — authtoken checks
 * (env first, then `config check` with the add-authtoken remediation),
 * API reachability gate, stdout JSON/regex URL harvest racing the local
 * API poll (https-ngrok hosts only), the 30 s timeout with the
 * summarizeNgrokOutput failure text, and normalization rules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startNgrokQuickTunnel, normalizeNgrokPublicUrl, urlFromLogLine, summarizeNgrokOutput,
} from '../lib/tunnels/ngrok-tunnel.ts';
import { setTunnelSpawnDepsForTests } from '../lib/tunnels/tunnel-spawn.ts';
import { TunnelServiceError } from '../lib/tunnels/tunnel-validate.ts';
import { FakeChild, fakeSpawnDeps, plantBinary, controllerFor, type FakeSpawnKit } from './helpers/tunnel-fakes.ts';

/** A quick-timeout kit with realistic stars: env authtoken set, binary
 * planted, api.ngrok.com reachable. */
function happyKit(api?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>): { kit: FakeSpawnKit; apiMock: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> } {
  const kitLocal = fakeSpawnDeps('/fake-root-ng');
  plantBinary(kitLocal, 'ngrok');
  const apiMock = api ?? (async () => new Response('OK', { status: 200 }));
  return { kit: kitLocal, apiMock };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  process.env.NGROK_AUTHTOKEN = 'env-token'; // env path assumed in most tests; paranoid-restores below
});

afterEach(() => {
  delete process.env.NGROK_AUTHTOKEN;
  setTunnelSpawnDepsForTests(null);
});

describe('ngrok quick prerequisites (§4.3)', () => {
  it('env authtoken path: spawns with the JSON log command; URL arrives from a JSON log line', async () => {
    const { kit: fake, apiMock } = happyKit();
    const noticed = startNgrokQuickTunnel(4022, { deps: fake.deps, fetch: apiMock, timeoutMs: 300 });
    await tick(); // prerequisites ride await — the spawn lands the next tick
    const spawn = fake.records[0]!;
    expect(spawn.request.command).toBe(`${fake.deps.searchPath()[0]}/ngrok`);
    expect(spawn.request.args).toEqual(['http', '--log=stdout', '--log-format=json', '127.0.0.1:4022']);
    spawn.child.stdout.push('{"lvl":"info","msg":"started tunnel"}');
    spawn.child.stdout.push('{"url":"https://8f28-1-2-3-4.ngrok-free.app/","msg":"started tunnel","addr":"http://localhost:4022"}');
    const controller = await noticed;
    expect(controller.getPublicUrl()).toBe('https://8f28-1-2-3-4.ngrok-free.app');
  });

  it('missing authtoken (no env, config check fails) is missing_dependency with the add-authtoken text', async () => {
    delete process.env.NGROK_AUTHTOKEN;
    const { kit: fake, apiMock } = happyKit();
    fake.deps.spawnSync = (_command, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'ngrok 3.11.0\n', stderr: '' }; // presence probe
      expect(args).toEqual(['config', 'check']);
      return { status: 1, stdout: '', stderr: 'no config file found' };
    };
    const rejection = await startNgrokQuickTunnel(4022, { deps: fake.deps, fetch: apiMock })
      .catch((error: TunnelServiceError) => error);
    expect(rejection).toBeInstanceOf(TunnelServiceError);
    expect((rejection as TunnelServiceError).code).toBe('missing_dependency');
    expect((rejection as TunnelServiceError).message).toContain('ngrok config add-authtoken <your-ngrok-token>');
    expect(fake.records).toHaveLength(0);
  });

  it('unreachable API gateway is a missing_dependency before spawn', async () => {
    const { kit: fake, apiMock } = happyKit(async () => { throw new Error('ECONNREFUSED'); });
    const rejection = await startNgrokQuickTunnel(4022, { deps: fake.deps, fetch: apiMock })
      .catch((error: TunnelServiceError) => error);
    expect((rejection as TunnelServiceError).code).toBe('missing_dependency');
    expect((rejection as TunnelServiceError).message).toContain('https://api.ngrok.com/');
    expect(fake.records).toHaveLength(0);
  });

  it('missing binary fails with the install hint before anything else', async () => {
    const fake = fakeSpawnDeps('/fake-root-ng-missing'); // deliberately NOT planted
    const apiMock = async () => new Response('OK', { status: 200 });
    const rejection = await startNgrokQuickTunnel(4022, { deps: fake.deps, fetch: apiMock })
      .catch((error: TunnelServiceError) => error);
    expect((rejection as TunnelServiceError).code).toBe('missing_dependency');
    expect((rejection as TunnelServiceError).message).toContain('ngrok is not available');
    expect(fake.records).toHaveLength(0);
  });
});

describe('ngrok quick URL harvest (§4.3)', () => {
  it('the local ngrok API supplies the URL when stdout stays quiet (https preferred)', async () => {
    const { kit: fake, apiMock } = happyKit(async () => new Response(JSON.stringify({ tunnels: [
      { proto: 'http', url: 'http://123.ngrok-2.app/' },
      { proto: 'https', url: 'https://456-7-8-9.ngrok-app.dev/' },
    ] }), { status: 200 }));
    const noticed = startNgrokQuickTunnel(4022, { deps: fake.deps, fetch: apiMock, timeoutMs: 400, pollMs: 5 });
    await tick();
    fake.records[0]!.child.stdout.push('{"lvl":"info","msg":"notifications not all acked"}');
    const controller = await noticed;
    expect(controller.getPublicUrl()).toBe('https://456-7-8-9.ngrok-app.dev');
    expect(controller.provider).toBe('ngrok');
    expect(controller.mode).toBe('quick');
  });

  it('non-ngrok API URLs are ignored and the poll keeps cycling until an ngrok host appears', async () => {
    let cycle = 0;
    const { kit: fake, apiMock } = happyKit(async () => {
      cycle += 1;
      if (cycle < 3) return new Response(JSON.stringify({ tunnels: [{ proto: 'https', url: 'https://foreign.tunnel.example.org/' }] }), { status: 200 });
      return new Response(JSON.stringify({ tunnels: [{ proto: 'https', url: `https://later-${cycle}.ngrok.io/` }] }), { status: 200 });
    });
    const noticed = startNgrokQuickTunnel(4022, { deps: fake.deps, fetch: apiMock, timeoutMs: 800, pollMs: 5 });
    const controller = await noticed;
    expect(controller.getPublicUrl()).toContain('.ngrok.io');
    expect(cycle).toBeGreaterThanOrEqual(3);
  });

  it('timeout (nothing valid anywhere) summarizes the harvested failure text', async () => {
    const { kit: fake, apiMock } = happyKit();
    const noticed = startNgrokQuickTunnel(4022, { deps: fake.deps, fetch: apiMock, timeoutMs: 40 });
    fake.records.length; // spawn may still be pending; the await below settles it
    const rejection = await noticed.catch((error: TunnelServiceError) => error);
    expect((rejection as TunnelServiceError).code).toBe('startup_failed');
    expect((rejection as TunnelServiceError).message).toContain('ngrok tunnel failed');
    expect(fake.records[0]!.child.signalCode).toBe('SIGINT');
  });

  it('child exit without a URL fails with the harvested error msg', async () => {
    const { kit: fake, apiMock } = happyKit();
    const noticed = startNgrokQuickTunnel(4022, { deps: fake.deps, fetch: apiMock, timeoutMs: 500 });
    await tick();
    const child = fake.records[0]!.child;
    child.stdout.push('{"lvl":"error","msg":"failed to authenticate"}');
    child.emitExit(1, null);
    const rejection = await noticed.catch((error: TunnelServiceError) => error);
    expect((rejection as TunnelServiceError).message).toContain('failed to authenticate');
  });
});

describe('ngrok url + summarizer units', () => {
  it('normalize requires https + an ngrok hostname, strips the trailing slash', () => {
    expect(normalizeNgrokPublicUrl('https://t1.ngrok-free.app/')).toBe('https://t1.ngrok-free.app');
    expect(normalizeNgrokPublicUrl('https://x.ngrok.io')).toBe('https://x.ngrok.io');
    expect(normalizeNgrokPublicUrl('http://t1.ngrok-free.app')).toBe(null);
    expect(normalizeNgrokPublicUrl('https://plain.example.com')).toBe(null);
    expect(normalizeNgrokPublicUrl('https://notngrok.io')).toBe('https://notngrok.io'); // substring contract: 'ngrok' in host
    expect(normalizeNgrokPublicUrl('https://')).toBe(null);
  });

  it('log-line harvest: JSON url/public_url keys, then the regex fallback for non-JSON lines', () => {
    expect(urlFromLogLine('{"t":"start","url":"https://a-b-c.ngrok.app/"}')).toBe('https://a-b-c.ngrok.app');
    expect(urlFromLogLine('{"public_url":"https://k.ngrok-free.app"}')).toBe('https://k.ngrok-free.app');
    expect(urlFromLogLine('http=tunneling protocol=https addr=1 url=https://12-34.ngrok.io')).toBe('https://12-34.ngrok.io');
    expect(urlFromLogLine('{"url":"http://also-not-secure.ngrok.io"}')).toBe(null);
  });

  it('summarizeNgrokOutput precedence: err-json (no context canceled) > error msg > ERROR: lines > last line', () => {
    expect(summarizeNgrokOutput([
      '{"lvl":"error","msg":"address already in use"}',
      '{"lvl":"error","err":"failed to bind"}',
    ])).toBe('ngrok tunnel failed: failed to bind');
    expect(summarizeNgrokOutput(['{"lvl":"error","err":"...context canceled..."}', '{"lvl":"error","msg":"session closed with error"}']))
      .toBe('ngrok tunnel failed: session closed with error');
    expect(summarizeNgrokOutput(['ERROR: ngrok HTTP proxy error', 'loose line'])).toBe('ngrok tunnel failed: ERROR: ngrok HTTP proxy error');
    expect(summarizeNgrokOutput(['free-tier limit reached'])).toBe('ngrok tunnel failed: free-tier limit reached');
    expect(summarizeNgrokOutput([])).toBe('ngrok tunnel failed: no output received');
  });
});

describe('controller construction parity', () => {
  it('controllerFor wires provider/mode/publicUrl (service reuse anchor contract)', () => {
    const controller = controllerFor('ngrok', 'quick', new FakeChild(), 'https://x.ngrok.io');
    expect(controller.provider).toBe('ngrok');
    expect(controller.getPublicUrl()).toBe('https://x.ngrok.io');
    expect(controller.isAlive()).toBe(true);
  });
});
