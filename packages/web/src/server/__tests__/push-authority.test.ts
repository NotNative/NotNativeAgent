// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UiAuthController } from '../lib/auth/ui-auth.ts';
import { pushGrant, pushAuthorityActive } from '../push/authority.ts';
import { RemoteClientStore } from '../lib/auth/remote-clients.ts';

const root = mkdtempSync(join(tmpdir(), 'nnd-push-authority-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('push recipient authority', () => {
  it('excludes expired and reset UI sessions without storing their bearer credential', () => {
    let now = 100_000;
    const auth = new UiAuthController({ dataDir: join(root, 'session'), now: () => now, resolvePassword: () => 'password' });
    const minted = auth.issueSessionToken(60_000);
    const headers = new Headers({ cookie: `oc_ui_session=${minted.token}` });
    const grant = auth.authenticate(headers, new URL('http://local/api/push/subscribe'), 'POST', false);
    expect(grant.ok).toBe(true); if (!grant.ok) throw new Error('fixture');
    const captured = pushGrant(grant, auth)!;
    expect(JSON.stringify(captured)).not.toContain(minted.token);
    expect(pushAuthorityActive(captured.authority, auth, now)).toBe(true);
    expect(pushAuthorityActive(captured.authority, auth, 160_000)).toBe(false);
    expect(auth.resetSessionAuth(headers).status).toBe(200);
    expect(pushAuthorityActive(captured.authority, auth, now)).toBe(false);
    expect(pushAuthorityActive(undefined, auth, now)).toBe(false);
  });

  it('excludes revoked or expired client credentials', () => {
    let now = 100_000;
    const dataDir = join(root, 'client');
    const auth = new UiAuthController({ dataDir, now: () => now, clientStore: new RemoteClientStore(dataDir, () => now) });
    const created = auth.getClientStore().createClient({ clientKind: 'desktop', expiresAt: new Date(160_000).toISOString() });
    const grant = auth.authenticate(new Headers({ authorization: `Bearer ${created.token}` }), new URL('http://local/api/push/subscribe'), 'POST', false);
    if (!grant.ok) throw new Error('fixture');
    const captured = pushGrant(grant, auth)!;
    expect(JSON.stringify(captured)).not.toContain(created.token);
    expect(pushAuthorityActive(captured.authority, auth, now)).toBe(true);
    now = 160_000; expect(pushAuthorityActive(captured.authority, auth, now)).toBe(false);
    now = 100_000; auth.getClientStore().revokeClient(created.client.id);
    expect(pushAuthorityActive(captured.authority, auth, now)).toBe(false);
  });
});
