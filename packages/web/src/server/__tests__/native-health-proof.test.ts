// SPDX-License-Identifier: Apache-2.0
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createNativeHealthProof } from '../lib/auth/native-health-proof.ts';
import { installNativeUiAuth, resetUiAuthForTests } from '../lib/auth/ui-auth.ts';

const origin = 'http://127.0.0.1:45012';
const identity = { installationId: `nna_${'a'.repeat(64)}`, dataId: `data_${'b'.repeat(64)}`,
  generation: 'selected-generation', origin, key: Buffer.alloc(32, 0x58).toString('base64url') };
const nonce = Buffer.alloc(32, 0x59).toString('base64url');
afterEach(() => resetUiAuthForTests());

describe('private supervised UI health proof', () => {
  it('answers only a bounded challenge with a domain-separated identity-bound MAC', async () => {
    installNativeUiAuth(identity);
    const app = createApp({ nativeHealthProof: identity });
    const proof = await app.request(`${origin}/__nna/health-proof`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    expect(proof.status).toBe(200);
    expect(proof.headers.get('cache-control')).toBe('no-store');
    const body = await proof.json() as { protocol: string; mac: string };
    const expected = createHmac('sha256', Buffer.from(identity.key, 'base64url'))
      .update(JSON.stringify(['NND_SUPERVISED_HEALTH_V1', nonce, identity.installationId,
        identity.dataId, identity.generation, origin])).digest('hex');
    expect(body).toEqual({ protocol: '1.0', mac: expected });
    expect(createNativeHealthProof({ ...identity, generation: 'other' })(nonce)).not.toBe(body.mac);
    expect(createNativeHealthProof(identity)(Buffer.alloc(32, 0x60).toString('base64url'))).not.toBe(body.mac);
    expect((await app.request(`${origin}/health`)).status).toBe(200);
  });

  it('has no route without private bootstrap and refuses malformed or oversized challenges', async () => {
    expect((await createApp().request(`${origin}/__nna/health-proof`, { method: 'POST',
      body: JSON.stringify({ nonce }) })).status).toBe(404);
    const app = createApp({ nativeHealthProof: identity });
    for (const body of [JSON.stringify({ nonce: 'a'.repeat(43) }), JSON.stringify({ nonce, extra: true }),
      'x'.repeat(129)]) {
      const response = await app.request(`${origin}/__nna/health-proof`, { method: 'POST', body });
      expect(response.status).toBe(400);
      expect((await response.text())).not.toContain(identity.key);
    }
  });
});
