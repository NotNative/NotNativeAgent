// SPDX-License-Identifier: Apache-2.0
/**
 * Edge public-key packaging for the relay E2EE trust anchor and the
 * ephemeral handshake key (doc 08 §3.2/§3.4). Public JWKs are reduced to
 * {kty,crv,x,y} everywhere (never serialized on the wire); the private
 * side of a handshake key never leaves the client session either.
 */

export interface RelayJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

/** Public JWK reduction (doc: `exportPublicKeyJwk`): keep {kty,crv,x,y}. */
export function reduceEcPublicJwk(jwk: RelayJwk): RelayJwk {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/** Fingerprint input: canonical JSON `{"crv","kty","x","y"}` in that order. */
export function publicKeyJwkFingerprint(jwk: RelayJwk): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

export function isShapedEcPublicJwk(value: unknown): value is RelayJwk {
  if (typeof value !== 'object' || value === null) return false;
  const jwk = value as Partial<RelayJwk>;
  return jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && jwk.x.length > 0
    && typeof jwk.y === 'string' && jwk.y.length > 0;
}
