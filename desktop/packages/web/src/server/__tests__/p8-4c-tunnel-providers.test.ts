// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4c gates part 3: the cloudflared provider drivers (§4.3) — quick
 * (URL harvest from stdout/stderr, 30 s timeout kill + temp-dir cleanup,
 * missing-binary error), managed-remote (token temp file 0o600 +
 * --token-file, ready/fatal patterns, 6 s liveness fallback, 20 s hard
 * failure, stdout drained WITHOUT logging, temp removed on exit/stop) and
 * managed-local (default str: missing config, guarded reads ≤ 256 KiB,
 * yaml/JSON ingress hostname, --config only when requested).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  startCloudflareQuickTunnel, QUICK_TUNNEL_URL_TIMEOUT_MS,
} from '../lib/tunnels/cloudflare-quick.ts';
import {
  startCloudflareManagedRemoteTunnel, startCloudflareManagedLocalTunnel,
  MANAGED_READY_LOG_PATTERNS, MANAGED_FATAL_LOG_PATTERNS, firstIngressHostname,
} from '../lib/tunnels/cloudflare-managed.ts';
import { MANAGED_LOCAL_DEFAULT_CONFIG_PATH } from '../lib/tunnels/tunnel-validate.ts';
import { checkExecutable, setTunnelSpawnDepsForTests } from '../lib/tunnels/tunnel-spawn.ts';
import { TunnelServiceError } from '../lib/tunnels/tunnel-validate.ts';
import { fakeSpawnDeps, plantBinary, type FakeSpawnKit } from './helpers/tunnel-fakes.ts';

const SHORT = { outputTimeoutMs: 40, livenessMs: 15 };

function kit(description: { binary?: boolean } = {}): FakeSpawnKit {
  const fake = fakeSpawnDeps('/fake-root');
  if (description.binary !== false) plantBinary(fake, 'cloudflared');
  return fake;
}

describe('cloudflared quick (§4.3)', () => {
  it('harvests the trycloudflare URL from either stream and SIGINTs on stop with temp cleanup', async () => {
    const fake = kit();
    const noticed = startCloudflareQuickTunnel(4021, { deps: fake.deps });
    const child = fake.records[0]!.child;
    child.stderr.push('scroll... https://abc-def-123.trycloudflare.com/');
    const controller = await noticed;
    expect(controller.getPublicUrl()).toBe('https://abc-def-123.trycloudflare.com');
    expect(controller.mode).toBe('quick');
    expect(controller.effectiveConfigPath()).toBe(null);
    expect(fake.records[0]!.request.command).toBe(`${fake.deps.searchPath()[0]}/cloudflared`);
    expect(fake.records[0]!.request.env?.CF_TELEMETRY_DISABLE).toBe('1');
    expect(fake.records[0]!.request.env?.HOME).toContain('openchamber-cf-quick-');
    expect(fake.records[0]!.request.args.slice(-2)).toEqual(['--url', 'http://127.0.0.1:4021']);
    controller.stop();
    expect(child.signalCode).toBe('SIGINT');
    expect(fake.removed[0]).toContain('openchamber-cf-quick-');
  });

  it('times out, kills the child, removes the temp HOME, and fails with the fixed text', async () => {
    const fake = kit();
    const noticed = startCloudflareQuickTunnel(4021, { deps: fake.deps, timeoutMs: 25 });
    await expect(noticed).rejects.toThrow('Tunnel URL not received within');
    expect(fake.records[0]!.child.signalCode).toBe('SIGINT');
    expect(fake.removed).toHaveLength(1);
  });

  it('child exit before a URL fails and cleans up', async () => {
    const fake = kit();
    const noticed = startCloudflareQuickTunnel(4021, { deps: fake.deps });
    const child = fake.records[0]!.child;
    child.emitExit(3, null);
    await expect(noticed).rejects.toThrow('exited before producing a tunnel URL');
    expect(fake.removed).toHaveLength(1);
  });

  it('missing cloudflared fails with the install hint before spawning', async () => {
    const fake = kit({ binary: false });
    await expect(startCloudflareQuickTunnel(4021, { deps: fake.deps })).rejects
      .toThrowError(expect.objectContaining({ code: 'missing_dependency', message: expect.stringContaining('cloudflared is not available') }));
    expect(fake.records).toHaveLength(0);
  });

  it('the 30 s default is the production contract constant', () => {
    expect(QUICK_TUNNEL_URL_TIMEOUT_MS).toBe(30_000);
  });
});

describe('managed-remote (§4.3)', () => {
  it('writes the token to a 0o600 temp file, spawns --token-file (never argv), and resolves the URL from the hostname', async () => {
    const fake = kit();
    const noticed = startCloudflareManagedRemoteTunnel(4021, { token: 'cf-run-token-xyz', hostname: 'Tunnel.Example.com' }, { deps: fake.deps, mirrorStderr: false, timeouts: SHORT });
    const child = fake.records[0]!.child;
    child.stdout.push('2024-10-05 INFO registered tunnel connection connIndex=1');
    const controller = await noticed;
    const spawn = fake.records[0]!;
    expect(spawn.request.command).toBe(`${fake.deps.searchPath()[0]}/cloudflared`);
    expect(spawn.request.args.join(' ')).toContain('--token-file');
    expect(spawn.request.args.join(' ')).not.toContain('cf-run-token-xyz'); // §12.1: run token never on argv
    expect(fake.written[0]!.mode).toBe(0o600);
    expect(fake.written[0]!.data).toBe('cf-run-token-xyz');
    expect(controller.getPublicUrl()).toBe('https://tunnel.example.com');
    expect(controller.resolvedHostname()).toBe('tunnel.example.com');
    controller.stop();
    expect(child.signalCode).toBe('SIGINT');
    expect(fake.removed.some((path) => path.includes('openchamber-cf-token-'))).toBe(true);
  });

  it('stdout is drained without logging; stderr mirror IS the only sink (§12.1)', async () => {
    const fake = kit();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const noticed = startCloudflareManagedRemoteTunnel(4021, { token: 'secret-token', hostname: 't.example.com' }, { deps: fake.deps, timeouts: SHORT });
    const child = fake.records[0]!.child;
    child.stdout.push('token=secret-token line that must never be logged');
    child.stderr.push('edge diagnostics');
    child.stdout.push('connection established registered');
    await noticed;
    const mirroring = write.mock.calls.map((call) => String(call[0]));
    expect(mirroring.some((entry) => entry.includes('edge diagnostics'))).toBe(true);
    expect(mirroring.join('')).not.toContain('secret-token'); // stdout never logged
    write.mockRestore();
  });

  it('fatal log patterns reject with the matched reason, kill the child, and remove the token temp', async () => {
    const fake = kit();
    const noticed = startCloudflareManagedRemoteTunnel(4021, { token: 'tok', hostname: 't.example.com' }, { deps: fake.deps, mirrorStderr: false, timeouts: SHORT });
    const child = fake.records[0]!.child;
    child.stdout.push('error: provided tunnel credentials are invalid');
    const rejection = await noticed.catch((error: TunnelServiceError) => error);
    expect(rejection).toBeInstanceOf(TunnelServiceError);
    expect((rejection as TunnelServiceError).code).toBe('startup_failed');
    expect((rejection as TunnelServiceError).message).toContain('provided tunnel credentials are invalid');
    expect(child.signalCode).toBe('SIGINT');
    expect(fake.removed.some((path) => path.includes('openchamber-cf-token-'))).toBe(true);
  });

  it('exiting before registration rejects with the exit contract', async () => {
    const fake = kit();
    const noticed = startCloudflareManagedRemoteTunnel(4021, { token: 'tok', hostname: 't.example.com' }, { deps: fake.deps, mirrorStderr: false, timeouts: SHORT });
    fake.records[0]!.child.emitExit(1, null);
    await expect(noticed).rejects.toThrow('exited before the tunnel registered');
  });

  it('ANY earlier output arms the 6 s liveness fallback (short-configured here)', async () => {
    const fake = kit();
    const noticed = startCloudflareManagedRemoteTunnel(4021, { token: 'tok', hostname: 't.example.com' }, { deps: fake.deps, mirrorStderr: false, timeouts: { outputTimeoutMs: 500, livenessMs: 15 } });
    const child = fake.records[0]!.child;
    child.stdout.push('noise line, no pattern');
    await noticed; // liveness resolves even without a ready pattern
  });

  it('silent children fail at the output timeout (20 s contract, shortened here)', async () => {
    const fake = kit();
    const noticed = startCloudflareManagedRemoteTunnel(4021, { token: 'tok', hostname: 't.example.com' }, { deps: fake.deps, mirrorStderr: false, timeouts: { outputTimeoutMs: 25, livenessMs: 5000 } });
    await expect(noticed).rejects.toThrow('readiness timed out');
  });

  it('missing token or hostname are validation errors', async () => {
    const fake = kit();
    await expect(startCloudflareManagedRemoteTunnel(4021, { token: null, hostname: 't.example.com' }, { deps: fake.deps }))
      .rejects.toThrow('Tunnel token is required');
    await expect(startCloudflareManagedRemoteTunnel(4021, { token: 'tok', hostname: null }, { deps: fake.deps }))
      .rejects.toThrow('Tunnel hostname is required');
  });

  it('ready/fatal pattern sets stay pinned (§4.3 contract vectors)', () => {
    expect(MANAGED_READY_LOG_PATTERNS.map((pattern) => pattern.test('Registered tunnel connection connIndex=0'))).toContain(true);
    expect(MANAGED_READY_LOG_PATTERNS.some((pattern) => pattern.test('connected to edge'))).toBe(true);
    expect(MANAGED_FATAL_LOG_PATTERNS.some((pattern) => pattern.test('invalid token'))).toBe(true);
    expect(MANAGED_FATAL_LOG_PATTERNS.some((pattern) => pattern.test('credentials file /x not found'))).toBe(true);
    expect(MANAGED_READY_LOG_PATTERNS.every((pattern) => !pattern.test('invalid token'))).toBe(true);
  });
});

describe('managed-local (§4.3)', () => {
  it('default str: missing ~/.cloudflared/config.yml fails with the default-message path', async () => {
    const fake = kit(); // kit.io has nothing: the default config path "does not exist"
    const rejection = await startCloudflareManagedLocalTunnel(4021, { configPath: null, hostname: null }, { deps: fake.deps }).catch((error: TunnelServiceError) => error);
    expect(rejection).toBeInstanceOf(TunnelServiceError);
    expect((rejection as TunnelServiceError).message).toContain('Default cloudflared config not found');
  });

  it('an explicit yaml config resolves firstIngress.hostname; --config rides argv only when requested', async () => {
    const fake = kit();
    const configPath = '/fake-root/temps/cfg.yml';
    fake.io.existsSet.add(configPath);
    fake.io.sizeMap.set(configPath, 120);
    fake.io.readTextMap.set(configPath, 'ingress:\n  - hostname: tunnel.example.com\n    service: http://localhost:4021\n  - service: http_status:404\n');
    const noticed = startCloudflareManagedLocalTunnel(4021, { configPath, hostname: null }, { deps: fake.deps, mirrorStderr: false, timeouts: SHORT });
    const child = fake.records[0]!.child;
    child.stdout.push('connected to edge');
    const controller = await noticed;
    expect(controller.getPublicUrl()).toBe('https://tunnel.example.com');
    expect(controller.effectiveConfigPath()).toBe(configPath);
    const args = fake.records[0]!.request.args;
    expect(args.join(' ')).toContain('--config');
    expect(args).toEqual(['tunnel', '--config', configPath, 'run']);
    controller.stop();
    expect(child.signalCode).toBe('SIGINT');
    expect(fake.removed).toHaveLength(0); // no temp token dir for managed-local
  });

  it('without a requested path the default config is read, but --config does NOT ride argv', async () => {
    const fake = kit();
    const defaultPath = MANAGED_LOCAL_DEFAULT_CONFIG_PATH;
    fake.io.existsSet.add(defaultPath.replace(/\\/gu, '/'));
    fake.io.sizeMap.set(defaultPath.replace(/\\/gu, '/'), 96);
    fake.io.readTextMap.set(defaultPath.replace(/\\/gu, '/'), 'ingress:\n  - hostname: default.example.com\n    service: http://localhost:4021\n');
    const noticed = startCloudflareManagedLocalTunnel(4021, { configPath: null, hostname: null }, { deps: fake.deps, mirrorStderr: false, timeouts: SHORT });
    fake.records[0]!.child.stdout.push('connected to edge');
    const controller = await noticed;
    expect(controller.getPublicUrl()).toBe('https://default.example.com');
    expect(controller.effectiveConfigPath()).toBe(defaultPath);
    expect(fake.records[0]!.request.args).toEqual(['tunnel', 'run']); // default: picked up by cloudflared itself
  });

  it('wildcard ingress hostname is treated as absent -> the both-fix-paths error', async () => {
    const fake = kit();
    const configPath = '/fake-root/temps/wild.yml';
    fake.io.existsSet.add(configPath);
    fake.io.sizeMap.set(configPath, 40);
    fake.io.readTextMap.set(configPath, 'ingress:\n  - hostname: "*"\n    service: http://localhost:80\n');
    await expect(startCloudflareManagedLocalTunnel(4021, { configPath, hostname: null }, { deps: fake.deps }))
      .rejects.toThrow('use --hostname or add an ingress hostname to the config');
  });

  it('explicit hostname argument wins over the config ingress', async () => {
    const fake = kit();
    const configPath = '/fake-root/temps/cfg2.yml';
    fake.io.existsSet.add(configPath);
    fake.io.sizeMap.set(configPath, 60);
    fake.io.readTextMap.set(configPath, 'ingress:\n  - hostname: config.example.com\n    service: http://localhost:80\n');
    const noticed = startCloudflareManagedLocalTunnel(4021, { configPath, hostname: 'Arg.Example.dev' }, { deps: fake.deps, mirrorStderr: false, timeouts: SHORT });
    fake.records[0]!.child.stdout.push('connected to edge');
    const controller = await noticed;
    expect(controller.resolvedHostname()).toBe('arg.example.dev');
  });

  it('guarded reads: oversize and bad-extension configs are validation errors', async () => {
    const fake = kit();
    const bigPath = '/fake-root/temps/big.yml';
    fake.io.existsSet.add(bigPath);
    fake.io.sizeMap.set(bigPath, 256 * 1024 + 1);
    fake.io.readTextMap.set(bigPath, 'ingress: []');
    await expect(startCloudflareManagedLocalTunnel(4021, { configPath: bigPath, hostname: 't.example.com' }, { deps: fake.deps }))
      .rejects.toThrow('under 256 KiB');
    const badPath = '/fake-root/temps/cfg.conf';
    fake.io.existsSet.add(badPath);
    fake.io.sizeMap.set(badPath, 12);
    fake.io.readTextMap.set(badPath, 'ingress: []');
    await expect(startCloudflareManagedLocalTunnel(4021, { configPath: badPath, hostname: 't.example.com' }, { deps: fake.deps }))
      .rejects.toThrow('must be .yml, .yaml or .json');
  });

  it('JSON ingress configs parse through the .json branch', async () => {
    const fake = kit();
    const configPath = '/fake-root/temps/cfg.json';
    fake.io.existsSet.add(configPath);
    fake.io.sizeMap.set(configPath, 80);
    fake.io.readTextMap.set(configPath, JSON.stringify({ ingress: [{ hostname: 'json.example.com', service: 'http://localhost:80' }] }));
    const noticed = startCloudflareManagedLocalTunnel(4021, { configPath, hostname: null }, { deps: fake.deps, mirrorStderr: false, timeouts: SHORT });
    fake.records[0]!.child.stdout.push('connected to edge');
    const controller = await noticed;
    expect(controller.getPublicUrl()).toBe('https://json.example.com');
  });

  it('firstIngressHostname helper: yaml parse failure is an explicit validation error', () => {
    expect(firstIngressHostname('ingress:\n- hostname: a.example.com\n', '/x/config.yml')).toBe('a.example.com');
    expect(() => firstIngressHostname('not: [valid...', '/x/config.yml'))
      .toThrowError(expect.objectContaining({ code: 'validation_error' }));
  });
});

describe('checkExecutable plumbing (§4.3)', () => {
  it('resolves the planted binary + --version probe; absent binary is unavailable', () => {
    const present = kit();
    expect(checkExecutable('cloudflared', present.deps)).toEqual({ available: true, version: 'cloudflared 2024.10.1', target: `${present.deps.searchPath()[0]}/cloudflared` });
    const absent = kit({ binary: false });
    expect(checkExecutable('cloudflared', absent.deps).available).toBe(false);
  });
});

afterEach(() => {
  setTunnelSpawnDepsForTests(null);
});
