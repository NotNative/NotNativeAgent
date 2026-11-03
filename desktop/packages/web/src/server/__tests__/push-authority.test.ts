// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UiAuthController } from '../lib/auth/ui-auth.ts';
import { pushGrant, pushAuthorityActive } from '../push/authority.ts';
import { pushCredentialOwner } from '../push/routes.ts';
import { RemoteClientStore } from '../lib/auth/remote-clients.ts';

const nativeIdentity = { installationId: 'nna_' + 'a'.repeat(64), dataId: 'data_' + 'b'.repeat(64), generation: 'generation-1', origin: 'http://127.0.0.1:32145' };

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

  it('keeps a credential-less caller inactive but an open desktop session active', () => {
    // Plain open mode (no password, no native mode) presents no credential.
    const serve = new UiAuthController({ dataDir: join(root, 'open'), resolvePassword: () => '' });
    const open = serve.authenticate(new Headers(), new URL('http://local/api/push/subscribe'), 'POST', false);
    if (!open.ok) throw new Error('fixture');
    expect(open.scope).toBe('open');
    expect(serve.openIsPrincipal(open)).toBe(false);
    expect(pushCredentialOwner(new Request('http://local/api/push/subscribe', { method: 'POST' }))).toBeNull();

    // The desktop serves that same open scope to its own window.
    const native = new UiAuthController({ dataDir: join(root, 'native'), nativeAuth: nativeIdentity, resolvePassword: () => '' });
    const desktop = native.authenticate(new Headers({ origin: nativeIdentity.origin }), new URL(nativeIdentity.origin + '/api/push/subscribe'), 'POST', false, '127.0.0.1');
    if (!desktop.ok) throw new Error('fixture');
    expect(native.openIsPrincipal(desktop)).toBe(true);
    const captured = pushGrant(desktop);
    expect(captured.authority).toEqual({ scope: 'open' });
    expect(pushAuthorityActive(captured.authority, native)).toBe(true);
    // No proof at all is still not active: absence is not a credential either way.
    expect(pushAuthorityActive(undefined, native)).toBe(false);
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
