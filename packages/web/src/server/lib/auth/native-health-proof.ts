// SPDX-License-Identifier: Apache-2.0
import { createHmac } from 'node:crypto';
import type { NativeUiIdentity } from './native-ui-auth.ts';

export interface NativeHealthProofIdentity extends NativeUiIdentity { key: string }
const KEY = /^[A-Za-z0-9_-]{43}$/u;

function canonicalKey(value: string): Buffer {
  if (!KEY.test(value)) throw new Error('Invalid native health proof key');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) throw new Error('Invalid native health proof key');
  return key;
}

/** Security: the response proves possession of this supervised child's private bootstrap key. */
export function createNativeHealthProof(identity: NativeHealthProofIdentity): (nonce: string) => string {
  const key = canonicalKey(identity.key);
  const binding = [identity.installationId, identity.dataId, identity.generation, identity.origin];
  return (nonce: string) => {
    canonicalKey(nonce);
    return createHmac('sha256', key).update(JSON.stringify(['NND_SUPERVISED_HEALTH_V1', nonce, ...binding])).digest('hex');
  };
}
