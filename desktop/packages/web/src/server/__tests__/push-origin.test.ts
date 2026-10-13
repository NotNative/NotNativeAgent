// SPDX-License-Identifier: Apache-2.0
import './helpers/env-boot.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createECDH } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ENV } from '../env.ts';
import { createPushRoutes } from '../push/routes.ts';
import { PushSubscriptionStore } from '../push/subscription-store.ts';
import { normalizedPublicOrigin, pushRegistrationOrigin } from '../push/registration-origin.ts';
import { readMergedSettings, readPublicOrigin, recordPublicOriginIfUnset, writeSettingsPatchLocked } from '../lib/settings-store.ts';
import { getUiAuthController } from '../lib/auth/ui-auth.ts';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

beforeEach(() => {
  for (const name of ['preferences.json', 'settings.json', 'push-subscriptions.json']) {
    try { unlinkSync(join(ENV.dataDir, name)); } catch { /* isolated test starts without this file */ }
  }
});
const doc = (name: string) => JSON.parse(readFileSync(join(ENV.dataDir, name), 'utf8'));
function registration(origin?: string) {
  const pair = createECDH('prime256v1'); pair.generateKeys();
  return { endpoint: 'https://push.example/one', keys: { p256dh: pair.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') },
    ...(origin === undefined ? {} : { origin }) };
}
function request(body: unknown, target = 'https://nnd.example', origin = target) {
  const token = getUiAuthController().issueSessionToken(60_000).token;
  return new Request(`${target}/api/push/subscribe`, { method: 'POST', headers: { origin, cookie: `oc_ui_session=${token}` }, body: JSON.stringify(body) });
}

describe('first Web Push application origin', () => {
  it('persists only a credentialed, validated registration and exposes it after a reload', async () => {
    const app = createPushRoutes();
    expect((await app.fetch(request(registration('https://NND.example:443/')))).status).toBe(200);
    expect(doc('preferences.json').fields.publicOrigin.value).toBe('https://nnd.example');
    expect(doc('settings.json').publicOrigin).toBe('https://nnd.example');
    expect(readMergedSettings('web').publicOrigin).toBe('https://nnd.example');
    expect(readPublicOrigin()).toBe('https://nnd.example');
    const second = { ...registration('https://other.example'), endpoint: 'https://push.example/two' };
    expect((await createPushRoutes().fetch(request(second, 'https://other.example'))).status).toBe(200);
    expect(readPublicOrigin()).toBe('https://nnd.example');
  });
  it('keeps registration compatible without an origin and ignores no existing configuration', async () => {
    expect((await createPushRoutes().fetch(request(registration()))).status).toBe(200);
    expect(readPublicOrigin()).toBeNull();
    writeFileSync(join(ENV.dataDir, 'settings.json'), JSON.stringify({ publicOrigin: 'https://operator.example', other: 7 }));
    await recordPublicOriginIfUnset('https://nnd.example', () => true);
    expect(readPublicOrigin()).toBe('https://operator.example');
    expect(doc('settings.json').other).toBe(7);
    expect(doc('preferences.json').fields.publicOrigin.value).toBe('https://operator.example');
    await writeSettingsPatchLocked({ chatRenderMode: 'live' }, 'web');
    expect(readMergedSettings('web').publicOrigin).toBe('https://operator.example');
  });
  it('retries a failed mirror write even when canonical origin already exists', async () => {
    const input = request(registration('https://retry.example'), 'https://retry.example');
    const rename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
    const fault = vi.mocked(renameSync).mockImplementation((source, target) => {
      if (target === join(ENV.dataDir, 'settings.json')) throw new Error('temporary mirror failure');
      return rename(source, target);
    });
    try {
      expect((await createPushRoutes().fetch(input.clone())).status).toBe(503);
      expect(doc('preferences.json').fields.publicOrigin.value).toBe('https://retry.example');
      expect(() => doc('settings.json')).toThrow();
    } finally { fault.mockRestore(); }
    expect((await createPushRoutes().fetch(input)).status).toBe(200);
    expect(doc('settings.json').publicOrigin).toBe('https://retry.example');
  });
  it('preserves a configured legacy origin when its canonical field is empty', async () => {
    writeFileSync(join(ENV.dataDir, 'preferences.json'), JSON.stringify({ version: 1, fields: { publicOrigin: { value: '', updatedAt: '2026-10-01' } } }));
    writeFileSync(join(ENV.dataDir, 'settings.json'), JSON.stringify({ publicOrigin: 'https://legacy.example', unrelated: true }));
    expect(readPublicOrigin()).toBe('https://legacy.example');
    await recordPublicOriginIfUnset('https://first.example', () => true);
    expect(doc('preferences.json').fields.publicOrigin.value).toBe('https://legacy.example');
    expect(doc('settings.json')).toMatchObject({ publicOrigin: 'https://legacy.example', unrelated: true });
  });
  it('recreates a removed mirror on registration retry instead of trusting the process digest', async () => {
    const input = request(registration('https://restore.example'), 'https://restore.example');
    expect((await createPushRoutes().fetch(input.clone())).status).toBe(200);
    unlinkSync(join(ENV.dataDir, 'settings.json'));
    expect((await createPushRoutes().fetch(input)).status).toBe(200);
    expect(doc('settings.json').publicOrigin).toBe('https://restore.example');
  });
  it('rejects a body origin that differs from the browser or request host before storing anything', async () => {
    const app = createPushRoutes();
    for (const input of [request(registration('https://evil.example')), request(registration('https://evil.example'), 'https://nnd.example', 'https://evil.example')]) {
      expect((await app.fetch(input)).status).toBe(400);
    }
    expect(readPublicOrigin()).toBeNull();
    expect(() => doc('push-subscriptions.json')).toThrow();
  });
  it('requires real credentials and preserves settings when subscription persistence fails', async () => {
    const unauthenticated = request(registration('https://nnd.example')); unauthenticated.headers.delete('cookie');
    expect((await createPushRoutes().fetch(unauthenticated)).status).toBe(401);
    const store = new PushSubscriptionStore(join(ENV.dataDir, 'push-subscriptions.json'));
    writeFileSync(store.path, '{broken');
    expect((await createPushRoutes({ store }).fetch(request(registration('https://nnd.example')))).status).toBe(503);
    expect(readPublicOrigin()).toBeNull();
  });
  it('fails rather than acknowledging a public-origin write over corrupt settings', async () => {
    writeFileSync(join(ENV.dataDir, 'preferences.json'), '{broken');
    expect((await createPushRoutes().fetch(request(registration('https://nnd.example')))).status).toBe(503);
    expect(readFileSync(join(ENV.dataDir, 'preferences.json'), 'utf8')).toBe('{broken');
  });
  it('serializes first writers with settings patches and forbids normal patches from replacing server ownership', async () => {
    await Promise.all([recordPublicOriginIfUnset('https://first.example', () => true), recordPublicOriginIfUnset('https://second.example', () => true),
      writeSettingsPatchLocked({ chatRenderMode: 'live', publicOrigin: 'https://evil.example' }, 'web')]);
    expect(readPublicOrigin()).toBe('https://first.example');
    expect(readMergedSettings('web').chatRenderMode).toBe('live');
    await expect(recordPublicOriginIfUnset('https://later.example', () => false)).rejects.toThrow('authority');
    expect(readPublicOrigin()).toBe('https://first.example');
  });
  it('binds the external origin to the first forwarded host after TLS termination', () => {
    const input = request({}, 'http://internal:3902', 'https://nnd.example');
    input.headers.set('x-forwarded-host', 'nnd.example, internal');
    expect(pushRegistrationOrigin('https://nnd.example', input)).toBe('https://nnd.example');
    expect(pushRegistrationOrigin('http://localhost:3902', new Request('http://localhost:3902/api/push/subscribe'))).toBe('http://localhost:3902');
    expect(normalizedPublicOrigin('http://[::1]:3902')).toBe('http://[::1]:3902');
  });
  it('registers securely treated IPv4 loopback origins throughout 127/8', async () => {
    const origin = 'http://127.0.0.2:3902';
    expect((await createPushRoutes().fetch(request(registration(origin), origin))).status).toBe(200);
    expect(readPublicOrigin()).toBe(origin);
    expect(normalizedPublicOrigin('http://127.255.255.254:3902')).toBe('http://127.255.255.254:3902');
  });
  it.each(['http://public.example', 'http://127.evil.example', 'http://192.168.1.2', 'https://user:pass@nnd.example', 'https://nnd.example/path', 'https://nnd.example?secret=1', 'https://nnd.example#hash', 'null', ' https://nnd.example', 'https://nnd.example\n'])('rejects invalid application origin %s', (origin) => {
    expect(normalizedPublicOrigin(origin)).toBeNull();
  });
});
