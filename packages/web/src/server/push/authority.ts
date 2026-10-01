// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { getUiAuthController, type AuthGranted, type UiAuthController } from '../lib/auth/ui-auth.ts';

export type PushAuthority = { scope: 'session'; expiresAt: number; epoch: string }
  | { scope: 'client'; clientId: string; tokenHash: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function validPushAuthority(value: unknown): value is PushAuthority {
  if (!value || typeof value !== 'object') return false;
  const proof = value as PushAuthority;
  return proof.scope === 'session' ? Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > 0 && /^[a-f0-9]{64}$/u.test(proof.epoch)
    : proof.scope === 'client' && typeof proof.clientId === 'string' && /^[a-z0-9_-]{1,128}$/iu.test(proof.clientId) && /^[a-f0-9]{64}$/u.test(proof.tokenHash);
}

export function pushGrant(grant: AuthGranted, controller: UiAuthController = getUiAuthController()): { owner: string; authority: PushAuthority } | null {
  if (grant.scope === 'open') return null;
  if (grant.scope === 'client') return { owner: digest(`client:${grant.clientId}`),
    authority: { scope: 'client', clientId: grant.clientId, tokenHash: grant.client.tokenHash } };
  const payload = JSON.parse(Buffer.from(grant.sessionToken.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number };
  return { owner: digest(`session:${grant.sessionToken}`),
    authority: { scope: 'session', expiresAt: payload.exp, epoch: digest(controller.jwtSecretForBinding()) } };
}

export function pushAuthorityActive(proof: PushAuthority | undefined, controller: UiAuthController = getUiAuthController(), now = Date.now()): boolean {
  if (!validPushAuthority(proof)) return false;
  if (proof.scope === 'session') return proof.expiresAt > now && proof.epoch === digest(controller.jwtSecretForBinding());
  return controller.getClientStore().getActiveClient(proof.clientId)?.tokenHash === proof.tokenHash;
}
