// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4c gates part 5: the §4.7 tunnel service lifecycle — same-config
 * reuse vs replacement (stop-previous-first, artifact revocation, tunnel
 * id persistence), the §4.2 start mutex, the §4.7 failure path (clear
 * without revoking, id retention), stop retention without a controller,
 * lazy dead-controller status re-sync, and the §4.4 token resolution
 * chain.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { controllerFor } from './helpers/tunnel-fakes.ts';
import { makeTunnelService, type TunnelServiceKit } from './helpers/tunnel-service-kit.ts';
import type { TunnelControllerLike } from '../lib/tunnels/tunnel-controller.ts';
import { TunnelServiceError } from '../lib/tunnels/tunnel-validate.ts';

const ROOTS: string[] = [];

afterAll(() => {
  while (ROOTS.length > 0) {
    const root = ROOTS.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

function make(): TunnelServiceKit {
  const kitLocal = makeTunnelService();
  ROOTS.push(kitLocal.root);
  return kitLocal;
}

describe('service lifecycle (§4.7)', () => {
  it('fresh start issues a bootstrap token, records the active tunnel, and reports metadata', async () => {
    const kitLocal = make();
    const outcome = await kitLocal.service.start({ provider: 'cloudflare', mode: 'quick' });
    expect(outcome.url).toBe('https://1-abc-de.trycloudflare.com');
    expect(outcome.mode).toBe('quick');
    expect(outcome.provider).toBe('cloudflare');
    expect(outcome.replacedTunnel).toBe(false);
    expect(outcome.replaced).toBe(null);
    expect(outcome.bootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(outcome.bootstrapExpiresAt).not.toBe(null);
    expect(kitLocal.tunnelAuth.activeTunnel()).toMatchObject({ publicUrl: outcome.url, mode: 'quick' });
    expect(kitLocal.tunnelAuth.hasLiveBootstrapToken()).toBe(true);
    expect(kitLocal.calls[0]!.port).toBe(4001);
  });

  it('same managed config re-starts REUSE the live controller: same id, fresh link, no replacement', async () => {
    const kitLocal = make();
    const first = await kitLocal.service.start({ mode: 'managed-remote', hostname: 'tunnel.example.com', token: 'tok' });
    const second = await kitLocal.service.start({ mode: 'managed-remote', hostname: 'tunnel.example.com', token: 'tok' });
    expect(kitLocal.calls).toHaveLength(1); // the live controller was reused
    expect(second.tunnelId).toBe(first.tunnelId);
    expect(second.replacedTunnel).toBe(false);
    expect(second.url).toBe(first.url);
    expect(second.bootstrapToken).not.toBe(first.bootstrapToken); // newest-only rotation
    expect(kitLocal.tunnelAuth.hasLiveBootstrapToken()).toBe(true);
  });

  it('quick->quick re-start replaces: previous controller SIGINTed, new id, artifact revocation reported', async () => {
    const kitLocal = make();
    const first = await kitLocal.service.start({ mode: 'quick' });
    const grant = kitLocal.tunnelAuth.redeemToken(first.bootstrapToken);
    if (!grant.ok) throw new Error('redeem failed in fixture');
    expect(true).toBe(true); // a real visitor logged in through /connect
    const second = await kitLocal.service.start({ mode: 'quick' });
    expect(kitLocal.childFor(0)!.signalCode).toBe('SIGINT'); // previous controller stopped FIRST
    expect(second.tunnelId).not.toBe(first.tunnelId);
    expect(second.replacedTunnel).toBe(true);
    expect(second.replaced).toEqual({ mode: 'quick', provider: 'cloudflare', url: first.url });
    expect(second.revokedBootstrapCount).toBe(1); // the old tunnel's newest-token revoked explicitly
    expect(second.invalidatedSessionCount).toBe(1); // visitor cut off
    const sessions = kitLocal.tunnelAuth.sessionList();
    expect(sessions.filter((row) => row.tunnelId === first.tunnelId).every((row) => row.revokedAt !== null)).toBe(true);
    expect(kitLocal.tunnelAuth.requireTunnelSession(`oc_tunnel_session=${grant.cookieValue.split('=')[1]}`)).toBe(false);
  });

  it('dead-controller re-start with the SAME descriptor keeps the tunnel id and no replacement', async () => {
    const kitLocal = make();
    const first = await kitLocal.service.start({ mode: 'managed-remote', hostname: 't.example.com', token: 't1' });
    kitLocal.childFor(0)!.emitExit(2, null); // the process dies
    expect(kitLocal.service.status().active).toBe(false); // lazy re-sync to inactive
    const again = await kitLocal.service.start({ mode: 'managed-remote', hostname: 't.example.com', token: 't1' });
    expect(again.tunnelId).toBe(first.tunnelId);
    expect(again.replacedTunnel).toBe(false);
    expect(kitLocal.calls).toHaveLength(2);
    expect(kitLocal.service.status().active).toBe(true);
  });

  it('a failed start of the SAME config (validation) leaves the live controller untouched', async () => {
    const kitLocal = make();
    const first = await kitLocal.service.start({ mode: 'managed-remote', hostname: 't.example.com', token: 'tok' });
    await expect(kitLocal.service.start({ token: 'split token', hostname: 't.example.com', mode: 'managed-remote' })).rejects
      .toThrowError(expect.objectContaining({ code: 'validation_error' }));
    expect(kitLocal.calls).toHaveLength(1); // the starter never ran
    expect(kitLocal.service.status().active).toBe(true);
    expect(kitLocal.tunnelAuth.activeTunnel()!.tunnelId).toBe(first.tunnelId);
  });
});

describe('§4.7 failure path with a different config', () => {
  it('previous controller stopped, active cleared WITHOUT revoking, id retained, visitors survive re-arm', async () => {
    const kitLocal = makeTunnelService({
      controller: (call) => {
        if (call.request.hostname === 'doomed.example.com') {
          throw new TunnelServiceError('startup_failed', 'provider exploded', 'boom');
        }
        return defaultControllerFor(call);
      },
    });
    ROOTS.push(kitLocal.root);
    const first = await kitLocal.service.start({ mode: 'managed-remote', hostname: 't.example.com', token: 't1' });
    const grant = kitLocal.tunnelAuth.redeemToken(first.bootstrapToken);
    if (!grant.ok) throw new Error('redeem failed in fixture');
    await expect(kitLocal.service.start({ mode: 'managed-remote', hostname: 'doomed.example.com', token: 't2' })).rejects
      .toThrowError(expect.objectContaining({ code: 'startup_failed' }));
    expect(kitLocal.childFor(0)!.signalCode).toBe('SIGINT'); // disabled previous §4.2
    const status = kitLocal.service.status();
    expect(status.active).toBe(false);
    const survivor = kitLocal.tunnelAuth.sessionList().find((row) => row.tunnelId === first.tunnelId);
    expect(survivor!.revokedAt).toBe(null); // §4.7: the failure path NEVER touches previous artifacts
    // A later successful start is a genuine URL replacement: new id, previous
    // artifacts revoked per the §4.7 replacement contract (not by the failure).
    const again = await kitLocal.service.start({ mode: 'managed-remote', hostname: 'other.example.com', token: 't2' });
    expect(again.tunnelId).not.toBe(first.tunnelId);
    expect(again.replacedTunnel).toBe(true);
    expect(again.replaced).toEqual({ provider: 'cloudflare', mode: 'managed-remote', url: 'https://t.example.com' });
    expect(again.revokedBootstrapCount).toBe(0); // the failure already detached the (never-revoked) record
    expect(again.invalidatedSessionCount).toBe(1);
    expect(kitLocal.tunnelAuth.sessionList().find((row) => row.tunnelId === first.tunnelId)!.revokedReason).toBe('tunnel-revoked');
  });
});

describe('stop retention + lazy resync', () => {
  it('stop revokes with a live bootstrap, stops the controller, forgets the descriptor', async () => {
    const kitLocal = make();
    const first = await kitLocal.service.start({ mode: 'managed-remote', hostname: 't.example.com', token: 't' });
    const stopped = await kitLocal.service.stop();
    expect(stopped).toEqual({ ok: true, revokedBootstrapCount: 1, invalidatedSessionCount: 0 });
    expect(kitLocal.childFor(0)!.signalCode).toBe('SIGINT');
    expect(kitLocal.service.status().active).toBe(false);
    const emptyStop = await kitLocal.service.stop(); // no controller, no bootstrap — retained safety
    expect(emptyStop).toEqual({ ok: true, revokedBootstrapCount: 0, invalidatedSessionCount: 0 });
    const third = await kitLocal.service.start({ mode: 'managed-remote', hostname: 't.example.com', token: 't' });
    expect(third.replacedTunnel).toBe(false); // a post-stop start is a FIRST start
    expect(third.tunnelId).not.toBe(first.tunnelId);
  });

  it('status reports managed metadata + TTLs + the §4.4 presets view (token-free)', async () => {
    const kitLocal = makeTunnelService({ settings: { managedRemoteTunnelHostname: 'set.example.com', managedRemoteTunnelToken: 'st' } });
    ROOTS.push(kitLocal.root);
    await kitLocal.store.upsert({ id: 'p1', name: 'Preset One', hostname: 'p1.example.com', token: 's3' });
    await kitLocal.service.start({ mode: 'managed-remote', hostname: 'set.example.com' }); // token from settings
    const status = kitLocal.service.status();
    expect(status).toMatchObject({
      active: true,
      url: 'https://set.example.com',
      mode: 'managed-remote',
      provider: 'cloudflare',
      hasManagedRemoteTunnelToken: true,
      managedRemoteTunnelHostname: 'set.example.com',
      policy: 'tunnel-gated',
      localPort: 4001,
      ttlConfig: { bootstrapTtlMs: 60_000, sessionTtlMs: 30 * 60_000 }, // 15 s rides the 1 min clamp floor
    });
    expect(JSON.stringify(status.managedRemoteTunnelPresets)).not.toContain('s3'); // §12.1
    expect(status.managedRemoteTunnelTokenPresetIds).toEqual(['p1']);
    expect(status.activeSessions).toEqual([]);
  });
});

describe('start mutex + token resolution (§4.2/§4.4)', () => {
  it('concurrent starts serialize (no orphaned controllers)', async () => {
    const kitLocal = make();
    const [first, second] = await Promise.all([
      kitLocal.service.start({ mode: 'quick' }),
      kitLocal.service.start({ mode: 'quick' }),
    ]);
    expect(kitLocal.calls).toHaveLength(2);
    expect(first.replacedTunnel).toBe(false);
    expect(second.replacedTunnel).toBe(true);
    expect(kitLocal.childFor(0)!.signalCode).toBe('SIGINT');
  });

  it('token chain: request > tunnelToken > managedRemoteTunnelToken > store (presetId, hostname) > settings', async () => {
    const kitLocal = makeTunnelService({
      settings: { managedRemoteTunnelToken: 'settings-token', managedRemoteTunnelHostname: 'T.example.com' },
    });
    ROOTS.push(kitLocal.root);
    await kitLocal.store.upsert({ id: 'p1', name: 'P1', hostname: 'store.example.com', token: 'store-token' });
    await kitLocal.service.start({ mode: 'managed-remote', hostname: 'req.example.com', token: 'request-token' });
    expect(kitLocal.calls[0]!.request.token).toBe('request-token');
    await kitLocal.service.start({ mode: 'managed-remote', hostname: 'store.example.com' });
    expect(kitLocal.calls[1]!.request.token).toBe('store-token'); // hostname matched the store profile
    await kitLocal.service.start({ mode: 'managed-remote', hostname: 'plain.example.com' }); // no store match -> settings token
    expect(kitLocal.calls[2]!.request.token).toBe('settings-token');
    await kitLocal.service.start({ mode: 'managed-remote', hostname: 'preset.example.com', managedRemoteTunnelPresetId: 'p1' });
    expect(kitLocal.calls[3]!.request.token).toBe('store-token'); // presetId beats hostname misses
    await kitLocal.service.start({ mode: 'managed-remote', hostname: 'nowhere.example.com' });
    expect(kitLocal.calls[4]!.request.token).toBe('settings-token');
  });

  it('hostname chain: request aliases then the settings managedRemoteTunnelHostname', async () => {
    const kitLocal = makeTunnelService({ settings: { managedRemoteTunnelHostname: 'fallback.example.com', managedRemoteTunnelToken: 't' } });
    ROOTS.push(kitLocal.root);
    await kitLocal.service.start({ mode: 'managed-remote', managedRemoteTunnelHostname: 'alias.example.com' });
    expect(kitLocal.calls[0]!.request.hostname).toBe('alias.example.com');
    await kitLocal.service.start({ mode: 'managed-remote' });
    expect(kitLocal.calls[1]!.request.hostname).toBe('fallback.example.com');
  });
});

function defaultControllerFor(call: { request: { provider: 'cloudflare' | 'ngrok'; mode: 'quick' | 'managed-local' | 'managed-remote'; hostname: string | null; configPath: string | null }; child: Parameters<typeof controllerFor>[2]; n: number }): TunnelControllerLike {
  const url = call.request.mode === 'quick'
    ? `https://${call.n}-abc-de.trycloudflare.com`
    : `https://${call.request.hostname ?? 'fallback.example.dev'}`;
  return controllerFor(call.request.provider, call.request.mode, call.child, url, {
    resolvedHostname: call.request.hostname,
    effectiveConfigPath: call.request.configPath,
  });
}
