// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/** Durable, non-secret identity of the provider destination used for an NND turn. */
export function nndProviderProfileFingerprint(profile) {
  if (!profile || !PROFILE_ID.test(profile.id ?? '')
    || typeof profile.endpoint !== 'string' || !profile.endpoint
    || !['loopback', 'private_network', 'public_network'].includes(profile.trustZone)
    || typeof profile.model !== 'string' || !profile.model) return null;
  const credential = profile.credential;
  let binding = null;
  if (credential !== null && credential !== undefined) {
    if (credential.source === 'environment' && typeof credential.name === 'string') {
      binding = ['environment', credential.name];
    } else if (credential.source === 'secret' && typeof credential.secretId === 'string'
      && typeof credential.field === 'string') {
      binding = ['secret', credential.secretId, credential.field];
    } else return null;
  }
  // The hash contains no raw destination or credential reference, yet catches
  // a same-ID profile remap after a config hot reload or process restart.
  return createHash('sha256').update(JSON.stringify([
    profile.id, profile.endpoint, profile.trustZone, profile.model, binding,
  ])).digest('hex');
}
