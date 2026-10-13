// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4c gates part 1: tunnel capabilities + §4.2 start-request
 * normalization (fallbacks, unsupported errors, home-containment, host
 * and token rules, intent matching), the §4.5 TTL clamps wired through
 * settings reads/writes, and the §4.7 startup env request.
 */
import './helpers/env-boot.ts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import {
  DEFAULT_TUNNEL_MODE, modeIntentDefault, ngrokTunnelProviderCapabilities,
  TUNNEL_PROVIDER_CAPABILITIES, tunnelModeCapability,
} from '../lib/tunnels/tunnel-capabilities.ts';
import {
  normalizeTunnelStartRequest, resolveTunnelConfigPath, resolveTunnelHostname,
  resolveTunnelToken, TunnelServiceError,
} from '../lib/tunnels/tunnel-validate.ts';
import { clampBootstrapTtl, clampSessionTtl, getTunnelAuthController, resetTunnelAuthForTests } from '../lib/auth/tunnel-auth.ts';
import { getManagedRemoteProfileStore, resetManagedRemoteProfileStoreForTests } from '../lib/tunnels/tunnel-profile-store.ts';
import { readTunnelSettingsDefaults, readEnvTunnelRequest, wireTunnelSettings } from '../lib/tunnels/tunnel-settings.ts';
import { setTunnelSpawnDepsForTests } from '../lib/tunnels/tunnel-spawn.ts';
import { writeSettingsPatch } from '../lib/settings-store.ts';
import { ENV } from '../env.ts';

afterAll(() => {
  resetTunnelAuthForTests();
  resetManagedRemoteProfileStoreForTests();
  setTunnelSpawnDepsForTests(null);
  for (const name of ['NOTNATIVE_TUNNEL_PROVIDER', 'NOTNATIVE_TUNNEL_MODE', 'NOTNATIVE_TUNNEL_HOSTNAME', 'NOTNATIVE_TUNNEL_TOKEN', 'NOTNATIVE_TUNNEL_CONFIG_PATH']) {
    delete process.env[name];
  }
});

beforeEach(() => {
  resetTunnelAuthForTests();
});

const HOME = homedir();

describe('provider/mode capability registry (§4.1)', () => {
  it('cloudflared carries the three modes with exact requires/supports', () => {
    const registry = TUNNEL_PROVIDER_CAPABILITIES;
    expect(registry.map((entry) => entry.key)).toEqual(['cloudflare', 'ngrok']);
    const cloudflare = registry[0]!.modes;
    expect(cloudflare.map((mode) => mode.key)).toEqual(['quick', 'managed-remote', 'managed-local']);
    expect(cloudflare[0]!.requires).toEqual(['binary']);
    expect(cloudflare[0]!.supports).toEqual(['sessionTTL']);
    expect(cloudflare[1]!.requires).toEqual(['binary', 'token', 'hostname']);
    expect(cloudflare[1]!.supports).toEqual(['customDomain', 'sessionTTL']);
    expect(cloudflare[2]!.requires).toEqual(['binary', 'configFile']);
    expect(cloudflare[2]!.supports).toEqual(['configFile', 'customDomain', 'sessionTTL']);
    const ngrok = ngrokTunnelProviderCapabilities();
    expect(ngrok.modes[0]!.stability).toBe('beta');
    expect(ngrok.modes[0]!.requires).toEqual(['binary', 'authtoken']);
    expect(ngrok.modes[0]!.intent).toBe('ephemeral-public');
  });

  it('mode intents and lookups follow the matrix', () => {
    expect(modeIntentDefault('quick')).toBe('ephemeral-public');
    expect(modeIntentDefault('managed-remote')).toBe('persistent-public');
    expect(modeIntentDefault('managed-local')).toBe('persistent-public');
    expect(tunnelModeCapability('cloudflare', 'quick').key).toBe('quick');
    expect(DEFAULT_TUNNEL_MODE).toBe('quick');
  });
});

describe('start-request normalization (§4.2)', () => {
  it('blank selections fall back to cloudflare/quick; defaults ride the settings layer', () => {
    const normalized = normalizeTunnelStartRequest({}, { provider: 'ngrok', mode: undefined });
    expect(normalized).toEqual({ provider: 'ngrok', mode: 'quick', intent: 'ephemeral-public', configPath: null, token: null, hostname: null });
    const untouched = normalizeTunnelStartRequest(null);
    expect(untouched.provider).toBe('cloudflare');
    expect(untouched.mode).toBe('quick');
    expect(untouched.intent).toBe('ephemeral-public');
  });

  it('extant-unrecognized provider/mode are unsupported errors, never silent fallbacks', () => {
    expect(() => normalizeTunnelStartRequest({ provider: 'boringproxy' })).toThrowError(expect.objectContaining({ code: 'provider_unsupported' }));
    expect(() => normalizeTunnelStartRequest({ provider: 42 })).toThrowError(expect.objectContaining({ code: 'provider_unsupported' }));
    expect(() => normalizeTunnelStartRequest({ mode: 'mirage', provider: ' nö' })).toThrowError(expect.objectContaining({ code: 'provider_unsupported' }));
    expect(() => normalizeTunnelStartRequest({ mode: 'mirage' })).toThrowError(expect.objectContaining({ code: 'mode_unsupported' }));
    expect(() => normalizeTunnelStartRequest({ mode: 'quick' })).not.toThrow();
    expect(() => normalizeTunnelStartRequest({ provider: 'ngrok', mode: 'managed-remote' })).toThrowError(expect.objectContaining({ code: 'mode_unsupported' }));
  });

  it('a carried intent must equal the mode intent; private-network is a recognized-but-unmatched string', () => {
    const matched = normalizeTunnelStartRequest({ mode: 'quick', intent: 'ephemeral-public' });
    expect(matched.intent).toBe('ephemeral-public');
    expect(() => normalizeTunnelStartRequest({ mode: 'quick', intent: 'persistent-public' }))
      .toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(() => normalizeTunnelStartRequest({ intent: 'private-network' }))
      .toThrowError(expect.objectContaining({ code: 'validation_error' }));
    const managed = normalizeTunnelStartRequest({ mode: 'managed-remote' });
    expect(managed.intent).toBe('persistent-public');
  });

  it('non-object bodies are validation errors', () => {
    expect(() => normalizeTunnelStartRequest('quick')).toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(() => normalizeTunnelStartRequest([1])).toThrowError(expect.objectContaining({ code: 'validation_error' }));
  });
});

describe('configPath/hostname/token validators (§4.2)', () => {
  it('configPath: `~` expansion and home containment (win32 case-insensitive)', () => {
    const tilde = resolveTunnelConfigPath('~/tunnels/config.yml');
    expect(tilde).toBe(pathJoin(HOME, 'tunnels/config.yml'));
    expect(resolveTunnelConfigPath('~/')).toBe(pathJoin(HOME, ''));
    expect(resolveTunnelConfigPath('')).toBe(null);
    expect(resolveTunnelConfigPath(null)).toBe(null);
    const inside = resolveTunnelConfigPath(pathJoin(HOME, 'cfg.yaml'));
    expect(inside).toBe(pathJoin(HOME, 'cfg.yaml'));
    if (process.platform === 'win32') {
      const upper = HOME.toUpperCase() + '\\a.yml';
      // case-insensitive containment on win32: accepted, resolved, not collapsed
      expect(resolveTunnelConfigPath(upper)).toBe(upper);
      expect(resolveTunnelConfigPath(upper)).not.toBe(null);
    }
    expect(() => resolveTunnelConfigPath('relative/config.yml')).toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(() => resolveTunnelConfigPath('/etc/passwd')).toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(() => resolveTunnelConfigPath('../escape.yml')).toThrowError(expect.objectContaining({ code: 'validation_error' }));
  });

  it('hostname: bare or URL forms normalize lower-case; wildcards/empties rejected', () => {
    expect(resolveTunnelHostname('https://Tunnel.Example.com/ingress')).toBe('tunnel.example.com');
    expect(resolveTunnelHostname('Host.Example.com')).toBe('host.example.com');
    expect(resolveTunnelHostname('t1-2-3-4.ngrok-free.app')).toBe('t1-2-3-4.ngrok-free.app');
    expect(resolveTunnelHostname('203.0.113.7')).toBe('203.0.113.7');
    expect(resolveTunnelHostname('')).toBe(null);
    expect(resolveTunnelHostname(undefined)).toBe(null);
    expect(() => resolveTunnelHostname('*.example.com')).toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(() => resolveTunnelHostname('bad host')).toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(() => resolveTunnelHostname('a..b.example')).toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(() => resolveTunnelHostname(9)).toThrowError(expect.objectContaining({ code: 'validation_error' }));
  });

  it('token: any whitespace is rejected with the raw-value remediation', () => {
    expect(() => resolveTunnelToken(' eyJ ')).toThrowError(/raw token/u);
    expect(() => resolveTunnelToken('a b c')).toThrowError(/raw token/u);
    expect(() => resolveTunnelToken('a\nb')).toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(resolveTunnelToken('eyJhbGciOiJIUzI1NiJ9')).toBe('eyJhbGciOiJIUzI1NiJ9');
    expect(resolveTunnelToken('')).toBe(null);
  });
});

describe('TTL clamps + settings wiring (§4.5)', () => {
  it('bootstrap clamp: 1 min–24 h with null disabling expiry; session clamp 5 min–30 d', () => {
    expect(clampBootstrapTtl(null)).toEqual({ enabled: false, ms: Number.MAX_SAFE_INTEGER });
    expect(clampBootstrapTtl(1000).ms).toBe(60_000);
    expect(clampBootstrapTtl(Number.MAX_SAFE_INTEGER).ms).toBe(24 * 60 * 60_000);
    expect(clampBootstrapTtl(undefined)).toEqual({ enabled: true, ms: 30 * 60_000 });
    expect(clampSessionTtl(1000)).toBe(5 * 60_000);
    expect(clampSessionTtl(undefined)).toBe(8 * 60 * 60_000);
  });

  it('wire applies clamped TTLs for tunnel-key writes and ignores unrelated patches', () => {
    const controller = getTunnelAuthController();
    wireTunnelSettings({ themeId: 'night' });
    expect(controller.bootstrapTtl.ms).toBe(30 * 60_000);
    wireTunnelSettings({ tunnelBootstrapTtlMs: 7_200_000, tunnelSessionTtlMs: 60_000 });
    expect(controller.bootstrapTtl.ms).toBe(7_200_000);
    expect(controller.sessionTtl).toBe(5 * 60_000); // 1 min rides the 5 min session floor
    wireTunnelSettings({ tunnelBootstrapTtlMs: 500 });
    expect(controller.bootstrapTtl.ms).toBe(60_000);
    wireTunnelSettings({ tunnelBootstrapTtlMs: null });
    expect(controller.bootstrapTtl.enabled).toBe(false);
    wireTunnelSettings({ tunnelSessionTtlMs: 1 });
    expect(controller.sessionTtl).toBe(5 * 60_000);
    // review P1: junk rides the clamp default, never disables expiry
    wireTunnelSettings({ tunnelBootstrapTtlMs: 'banana' });
    expect(controller.bootstrapTtl.enabled).toBe(true);
    expect(controller.bootstrapTtl.ms).toBe(30 * 60_000);
    wireTunnelSettings({ tunnelSessionTtlMs: 'junk' });
    expect(controller.sessionTtl).toBe(5 * 60_000);
  });
});

describe('settings-file plumbing (§11.2)', () => {
  it('registered keys land in preferences.json and ride the defaults reader (token never echoed)', () => {
    const outcome = writeSettingsPatch({
      tunnelProvider: 'ngrok',
      tunnelMode: 'quick',
      managedRemoteTunnelHostname: 'Tunnel.Example.com',
      managedRemoteTunnelToken: 'raw-token-123',
      tunnelBootstrapTtlMs: null,
      tunnelSessionTtlMs: 10_800_000,
    }, 'web');
    expect(outcome.dropped).toEqual([]);
    expect(outcome.settings['managedRemoteTunnelToken']).toBeUndefined(); // secrets never travel out
    const defaults = readTunnelSettingsDefaults();
    expect(defaults.provider).toBe('ngrok');
    expect(defaults.mode).toBe('quick');
    expect(defaults.managedRemoteTunnelHostname).toBe('Tunnel.Example.com');
    expect(defaults.managedRemoteTunnelToken).toBe('raw-token-123');
    expect(defaults.tunnelBootstrapTtlMs).toBe(null); // explicit null disables expiry
    expect(defaults.tunnelSessionTtlMs).toBe(10_800_000);
  });

  it('junk TTL values fall back to clamped defaults instead of corrupting reads', () => {
    writeSettingsPatch({ tunnelBootstrapTtlMs: 'banana', tunnelSessionTtlMs: -5 }, 'web');
    const defaults = readTunnelSettingsDefaults();
    expect(defaults.tunnelBootstrapTtlMs).toBe(30 * 60_000);
    expect(defaults.tunnelSessionTtlMs).toBe(8 * 60 * 60_000);
  });

  it('profile-store resolution rides the same dataDir as the composition root', async () => {
    expect(getManagedRemoteProfileStore({ dataDir: ENV.dataDir }).list()).toEqual([]);
  });
});

describe('startup tunnel env request (§4.7)', () => {
  it('absent env means no startup tunnel; present env builds the request', () => {
    expect(readEnvTunnelRequest()).toBe(null);
    process.env.NOTNATIVE_TUNNEL_PROVIDER = ' cloudflare ';
    process.env.NOTNATIVE_TUNNEL_MODE = 'managed-local ';
    process.env.NOTNATIVE_TUNNEL_CONFIG_PATH = '~/tunnels/c.yml';
    const request = readEnvTunnelRequest();
    expect(request).toEqual({ provider: 'cloudflare', mode: 'managed-local', configPath: '~/tunnels/c.yml' });
    process.env.NOTNATIVE_TUNNEL_HOSTNAME = 'src.example.dev';
    process.env.NOTNATIVE_TUNNEL_TOKEN = 'tok';
    expect(readEnvTunnelRequest()).toEqual({ provider: 'cloudflare', mode: 'managed-local', configPath: '~/tunnels/c.yml', hostname: 'src.example.dev', token: 'tok' });
    delete process.env.NOTNATIVE_TUNNEL_PROVIDER;
    delete process.env.NOTNATIVE_TUNNEL_MODE;
    expect(readEnvTunnelRequest()).toBe(null); // hostname/token alone do not arm the startup tunnel
  });
});

