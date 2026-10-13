// SPDX-License-Identifier: Apache-2.0
/**
 * Relay Layer 2 — E2EE channel (doc 08 §3.4), client contract side.
 * ECDH P-256 → HKDF-SHA-256 (salt = the handshake nonce, info =
 * 'openchamber-relay-v1', 512 bits) → two AES-256-GCM keys, one per
 * direction. WebCrypto only, identical parameters to the host mirror so
 * frames cross-decrypt. IV = 4 B random per-direction prefix + 8 B BE
 * counter from 1; frame = [version=1][12B IV][ct||16B tag]; decryptor
 * fails closed. One encrypt() == one WS message == one counter tick.
 * Counters above 2^53-1 are rejected (unrepresentable exactly).
 */
import { RELAY_HKDF_INFO, RELAY_PROTOCOL_VERSION, utf8Bytes, utf8Text, bytesToBase64Url, base64UrlToBytes } from './bytes.ts';
import { reduceEcPublicJwk, publicKeyJwkFingerprint, isShapedEcPublicJwk, type RelayJwk } from './protocol-jwk.ts';

export const MAX_PLAINTEXT_FRAME_BYTES = 64 * 1024;
export const ENCRYPTED_FRAME_HEADER_BYTES = 13;
export const GCM_TAG_BYTES = 16;
export const MIN_ENCRYPTED_FRAME_BYTES = ENCRYPTED_FRAME_HEADER_BYTES + GCM_TAG_BYTES;
/** 5B tunnel frame header + 5B batch envelope worst-case headroom. */
export const MAX_TUNNEL_PAYLOAD_BYTES = MAX_PLAINTEXT_FRAME_BYTES - 5 - 5;

const MAX_SAFE_FRAME_COUNTER = BigInt(Number.MAX_SAFE_INTEGER);

/** Structural AES-GCM key name; subtle rides `typeof crypto.subtle` so the
 * same file typechecks DOM-side (ui) and node-side (web cross-compat tests). */
type AesGcmKey = Parameters<typeof crypto.subtle.encrypt>[1];
type SubtleLike = typeof crypto.subtle;

function subtle(): SubtleLike {
  const scope = typeof crypto !== 'undefined' ? crypto : undefined;
  if (!scope) throw new Error('WebCrypto unavailable');
  return scope.subtle;
}

export interface EphemeralKeypair {
  privateJwk: RelayJwk;
  publicJwk: RelayJwk;
}

/** extractable per §3.4 so the private JWK can serialize into debugging
 * harnesses; the wire itself only ever carries the reduced public JWK. */
export async function generateEphemeralKeypair(): Promise<EphemeralKeypair> {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const privateJwk = await subtle().exportKey('jwk', pair.privateKey) as RelayJwk;
  const publicJwk = await subtle().exportKey('jwk', pair.publicKey) as RelayJwk;
  return { privateJwk, publicJwk: reduceEcPublicJwk(publicJwk) };
}

export function randomNonceBytes(): Uint8Array {
  const scope = typeof crypto !== 'undefined' ? crypto : undefined;
  if (!scope) throw new Error('WebCrypto unavailable');
  return scope.getRandomValues(new Uint8Array(16));
}

export function randomNonceB64url(): string {
  return bytesToBase64Url(randomNonceBytes());
}

export { reduceEcPublicJwk, publicKeyJwkFingerprint, isShapedEcPublicJwk };
export type { RelayJwk };

/** One random 4 B prefix per direction per handshake. */
export interface SessionDirection {
  readonly key: AesGcmKey;
  readonly ivPrefix: Uint8Array;
  counter: number; // next value; strictly increasing from 1
  lastCounter: number; // highest accepted inbound counter (decrypt side)
}

export interface SessionKeyPair {
  clientToHostKey: AesGcmKey;
  hostToClientKey: AesGcmKey;
}

export interface OpenedSession {
  clientToHost: SessionDirection;
  hostToClient: SessionDirection;
}

/** ECDH P-256 → HKDF-SHA-256 → the two direction keys (§3.4 table). */
export async function deriveSessionKeys(
  ownPrivateJwk: RelayJwk,
  peerPublicJwk: RelayJwk,
  nonceB64url: string,
): Promise<SessionKeyPair> {
  const subtleSub = subtle();
  const peerKey = await subtleSub.importKey(
    'jwk', reduceEcPublicJwk(peerPublicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const ownKey = await subtleSub.importKey(
    'jwk', ownPrivateJwk as never, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
  );
  const sharedSecret = await subtleSub.deriveBits({ name: 'ECDH', public: peerKey }, ownKey, 256);
  const hkdfKey = await subtleSub.importKey('raw', asBufferSource(new Uint8Array(sharedSecret)), 'HKDF', false, ['deriveBits']);
  const keyMaterialBytes = new Uint8Array(await subtleSub.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: asBufferSource(base64UrlToBytes(nonceB64url)),
      info: asBufferSource(utf8Bytes(RELAY_HKDF_INFO)),
    },
    hkdfKey,
    512,
  ));
  if (keyMaterialBytes.length !== 64) throw new Error('HKDF produced an unexpected length');
  const nonceBytes = base64UrlToBytes(nonceB64url);
  if (nonceBytes.length !== 16) throw new Error('handshake nonce must be 16 bytes');
  return {
    clientToHostKey: await importDirectionKey(subtleSub, keyMaterialBytes.slice(0, 32)),
    hostToClientKey: await importDirectionKey(subtleSub, keyMaterialBytes.slice(32, 64)),
  };
}

async function importDirectionKey(subtleSub: SubtleLike, raw: Uint8Array): Promise<AesGcmKey> {
  return await subtleSub.importKey('raw', asBufferSource(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function openSession(keys: SessionKeyPair): OpenedSession {
  const scope = typeof crypto !== 'undefined' ? crypto : undefined;
  if (!scope) throw new Error('WebCrypto unavailable');
  return {
    clientToHost: newDirection(keys.clientToHostKey),
    hostToClient: newDirection(keys.hostToClientKey),
  };
}

function newDirection(key: AesGcmKey): SessionDirection {
  return {
    key,
    ivPrefix: crypto.getRandomValues(new Uint8Array(4)),
    counter: 1,
    lastCounter: 0,
  };
}

function ivFor(direction: SessionDirection, counter: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(direction.ivPrefix.subarray(0, 4), 0);
  writeCounterBE(iv, BigInt(counter), 4);
  return iv;
}

function writeCounterBE(bytes: Uint8Array, value: bigint, offset: number): void {
  for (let i = 7; i >= 0; i -= 1) {
    bytes[offset + i] = Number((value & 0xffn));
    value >>= 8n;
  }
}

/** One encrypt() == one WS message == one counter tick (§3.4). */
export async function encryptFrame(direction: SessionDirection, plaintext: Uint8Array): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT_FRAME_BYTES) {
    throw new Error(`frame plaintext exceeds ${MAX_PLAINTEXT_FRAME_BYTES} bytes`);
  }
  const counter = direction.counter;
  direction.counter = counter + 1;
  const iv = ivFor(direction, counter);
  const subtleSub = subtle();
  const ciphertext = await subtleSub.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, direction.key, asBufferSource(plaintext));
  const head = new Uint8Array(ENCRYPTED_FRAME_HEADER_BYTES);
  head[0] = RELAY_PROTOCOL_VERSION;
  head.set(iv, 1);
  return concatBytes(head, new Uint8Array(ciphertext));
}

/** Fail-closed decrypt: min length, version, strictly increasing counter
 * (regression or replay = tampering), then GCM; acceptance advances
 * lastCounter. Inbound decryption serialization is the caller's promise
 * chain (the counter check requires wire order). */
export async function decryptFrame(direction: SessionDirection, frame: Uint8Array): Promise<Uint8Array> {
  if (frame.length < MIN_ENCRYPTED_FRAME_BYTES) throw new Error('encrypted frame too short');
  if (frame[0] !== RELAY_PROTOCOL_VERSION) throw new Error('unsupported encrypted frame version');
  const wireCounter = readCounterBE(frame, 5);
  if (wireCounter > MAX_SAFE_FRAME_COUNTER) throw new Error('encrypted frame counter exceeds the exact range');
  const counter = Number(wireCounter);
  if (counter <= direction.lastCounter) throw new Error('encrypted frame counter regression or replay');
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt({ name: 'AES-GCM', iv: asBufferSource(frame.slice(1, 13)) }, direction.key, asBufferSource(frame.subarray(13)));
  } catch {
    throw new Error('GCM authentication failed');
  }
  direction.lastCounter = counter;
  return new Uint8Array(plaintext);
}

function readCounterBE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value = (value << 8n) | BigInt(bytes[offset + i] as number);
  }
  return value;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---- handshake messages (plaintext JSON text frames; foreign v = ignored) --

export function encodeHandshakeHello(input: {
  clientPubJwk: RelayJwk;
  nonceB64url: string;
  batch?: boolean;
  flowControl?: boolean;
}): Uint8Array {
  const message: Record<string, unknown> = {
    t: 'hello',
    v: RELAY_PROTOCOL_VERSION,
    clientPubJwk: reduceEcPublicJwk(input.clientPubJwk),
    nonce: input.nonceB64url,
  };
  if (input.batch === true) message.batch = true;
  if (input.flowControl === true) message.flowControl = true;
  return utf8Bytes(JSON.stringify(message));
}

export function encodeHandshakeReady(input: { batch?: boolean; flowControl?: boolean }): Uint8Array {
  const message: Record<string, unknown> = { t: 'ready', v: RELAY_PROTOCOL_VERSION };
  if (input.batch === true) message.batch = true;
  if (input.flowControl === true) message.flowControl = true;
  return utf8Bytes(JSON.stringify(message));
}

export interface DecodedHello {
  t: 'hello';
  clientPubJwk: RelayJwk;
  nonce: string;
  batch: boolean;
  flowControl: boolean;
}

export interface DecodedReady {
  t: 'ready';
  batch: boolean;
  flowControl: boolean;
}

export function decodeHandshakeHello(bytes: Uint8Array): DecodedHello | null {
  try {
    const parsed = JSON.parse(utf8Text(bytes)) as (Partial<DecodedHello> & { v?: unknown }) | null;
    if (!parsed || typeof parsed !== 'object' || parsed.t !== 'hello' || parsed.v !== RELAY_PROTOCOL_VERSION) return null;
    if (!isShapedEcPublicJwk(parsed.clientPubJwk) || typeof parsed.nonce !== 'string' || parsed.nonce === '') return null;
    return {
      t: 'hello',
      clientPubJwk: parsed.clientPubJwk as RelayJwk,
      nonce: parsed.nonce,
      batch: parsed.batch === true,
      flowControl: parsed.flowControl === true,
    };
  } catch {
    return null;
  }
}

export function decodeHandshakeReady(bytes: Uint8Array): DecodedReady | null {
  try {
    const parsed = JSON.parse(utf8Text(bytes)) as (Partial<DecodedReady> & { v?: unknown }) | null;
    if (!parsed || typeof parsed !== 'object' || parsed.t !== 'ready' || parsed.v !== RELAY_PROTOCOL_VERSION) return null;
    return { t: 'ready', batch: parsed.batch === true, flowControl: parsed.flowControl === true };
  } catch {
    return null;
  }
}

/** Fingerprint-ordered public key comparison (host parity helper). */
export function sameClientKey(a: RelayJwk, b: RelayJwk): boolean {
  return publicKeyJwkFingerprint(a) === publicKeyJwkFingerprint(b);
}

/** WebCrypto boundary coercion (TS 5.9 Uint8Array generics; runtime no-op). */
function asBufferSource(bytes: Uint8Array): never {
  return bytes as never; // frames line up with every subtle param position
}
