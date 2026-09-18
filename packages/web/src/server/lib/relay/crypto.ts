// SPDX-License-Identifier: Apache-2.0
/**
 * Relay Layer 2 — E2EE channel (doc 08 section 3.4): ECDH P-256 ->
 * HKDF-SHA-256 (salt = the handshake nonce, info = utf8
 * 'openchamber-relay-v1', 512 bits) -> two AES-256-GCM keys, one per
 * direction. IV = 4 B random per-direction prefix + 8 B big-endian frame
 * counter starting at 1 (+1 per encryption call). Encrypted frame = one
 * binary WS message `[version=1][12B IV][ciphertext||16B tag]`; the
 * decryptor fails closed (size, version, counter regression/replay, GCM).
 * Fresh handshake per connection: no resumption, counters reset.
 */
import { webcrypto } from 'node:crypto';

/** Structural substitute for the DOM-bound global CryptoKey name. */
type AesGcmKey = Parameters<typeof webcrypto.subtle.encrypt>[1];
import type { RelayJwk } from './identity.ts';

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_HKDF_INFO = 'openchamber-relay-v1';
export const MAX_PLAINTEXT_FRAME_BYTES = 64 * 1024;
export const ENCRYPTED_FRAME_HEADER_BYTES = 13;
export const GCM_TAG_BYTES = 16;
export const MIN_ENCRYPTED_FRAME_BYTES = ENCRYPTED_FRAME_HEADER_BYTES + GCM_TAG_BYTES;
export const MAX_TUNNEL_PAYLOAD_BYTES = MAX_PLAINTEXT_FRAME_BYTES - 5 - 5;

/** Counters above 2^53-1 are never minted by a correct peer and Number()
 * could not represent them exactly; reject before any state comparison. */
const MAX_SAFE_FRAME_COUNTER = BigInt(Number.MAX_SAFE_INTEGER);

const subtle = webcrypto.subtle;

export interface EphemeralKeypair {
  privateJwk: RelayJwk;
  publicJwk: RelayJwk;
}

export async function generateEphemeralKeypair(): Promise<EphemeralKeypair> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const privateJwk = await subtle.exportKey('jwk', pair.privateKey) as RelayJwk;
  const publicJwk = waitPublicJwk(await subtle.exportKey('jwk', pair.publicKey));
  return { privateJwk, publicJwk };
}

function waitPublicJwk(jwk: unknown): RelayJwk {
  const { kty, crv, x, y } = jwk as RelayJwk;
  return { kty, crv, x, y };
}

/** Public JWK reduction: {kty,crv,x,y} only — private members never leave
 * the key store (doc: `exportPublicKeyJwk`). */
export function reduceEcPublicJwk(jwk: RelayJwk): RelayJwk {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export function publicKeyJwkFingerprint(jwk: RelayJwk): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

export function randomNonceBytes(base64url: string): Uint8Array {
  const bytes = Buffer.from(base64url, 'base64url');
  if (bytes.length !== 16) throw new Error('handshake nonce must be 16 bytes');
  return bytes;
}

/** ECDH P-256 -> HKDF-SHA-256 -> {clientToHost, hostToClient} AES-GCM keys
 * (each 32 B, imported non-extractable, encrypt+decrypt usage). */
export async function deriveSessionKeys(
  ownPrivateJwk: RelayJwk,
  peerPublicJwk: RelayJwk,
  nonceB64url: string,
): Promise<SessionKeyPair> {
  const sharedSecret = await subtle.deriveBits(
    { name: 'ECDH', public: await subtle.importKey('jwk', reduceEcPublicJwk(peerPublicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []) },
    await subtle.importKey('jwk', ownPrivateJwk as never, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    256,
  );
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const keyMaterial = new Uint8Array(await subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: randomNonceBytes(nonceB64url),
      info: Buffer.from(RELAY_HKDF_INFO, 'utf8'),
    },
    hkdfKey,
    512,
  ));
  if (keyMaterial.length !== 64) throw new Error('HKDF produced an unexpected length');
  return {
    clientToHostKey: await deriveDirection(keyMaterial.slice(0, 32)),
    hostToClientKey: await deriveDirection(keyMaterial.slice(32, 64)),
  };
}

async function deriveDirection(raw: Uint8Array): Promise<AesGcmKey> {
  return await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface SessionDirection {
  readonly key: AesGcmKey;
  readonly ivPrefix: Uint8Array; // 4 B, random per direction per handshake
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

function newDirection(key: AesGcmKey): SessionDirection {
  return { key, ivPrefix: webcrypto.getRandomValues(new Uint8Array(4)), counter: 1, lastCounter: 0 };
}

export function openSession(keys: SessionKeyPair): OpenedSession {
  return {
    clientToHost: newDirection(keys.clientToHostKey),
    hostToClient: newDirection(keys.hostToClientKey),
  };
}

function ivFor(direction: SessionDirection, counter: number): Buffer {
  const iv = Buffer.alloc(12);
  Buffer.from(direction.ivPrefix).copy(iv, 0);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  return iv;
}

/** One encrypt() == one WS message == one counter tick. */
export async function encryptFrame(direction: SessionDirection, plaintext: Uint8Array): Promise<Buffer> {
  if (plaintext.length > MAX_PLAINTEXT_FRAME_BYTES) {
    throw new Error(`frame plaintext exceeds ${MAX_PLAINTEXT_FRAME_BYTES} bytes`);
  }
  const counter = direction.counter;
  direction.counter = counter + 1;
  const iv = ivFor(direction, counter);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, direction.key, plaintext);
  return Buffer.concat([
    Buffer.of(RELAY_PROTOCOL_VERSION),
    iv,
    Buffer.from(ciphertext),
  ]);
}

/** Fail-closed decrypt: min length, version, strictly increasing counter
 * (regression or replay = tampering), then GCM; acceptance advances
 * lastCounter. Serialization of inbound decryption is the caller's
 * promise chain (the counter check requires wire order). */
export async function decryptFrame(direction: SessionDirection, frame: Uint8Array): Promise<Uint8Array> {
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (bytes.length < MIN_ENCRYPTED_FRAME_BYTES) throw new Error('encrypted frame too short');
  if (bytes[0] !== RELAY_PROTOCOL_VERSION) throw new Error('unsupported encrypted frame version');
  const wireCounter = bytes.readBigUInt64BE(5); // IV = 4B prefix (1..4) + 8B BE counter (5..13)
  if (wireCounter > MAX_SAFE_FRAME_COUNTER) throw new Error('encrypted frame counter exceeds the exact range');
  const counter = Number(wireCounter);
  if (counter <= direction.lastCounter) {
    throw new Error('encrypted frame counter regression or replay');
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13) }, direction.key, bytes.subarray(13));
  } catch {
    throw new Error('GCM authentication failed');
  }
  direction.lastCounter = counter;
  return new Uint8Array(plaintext);
}

/** Handshake messages (plaintext JSON text frames; foreign v values are
 * ignored by consumers). hello: client->host re-sent every 1 s until
 * established; ready: host->client. */
export function encodeHandshakeHello(input: {
  clientPubJwk: RelayJwk;
  nonceB64url: string;
  batch?: boolean;
  flowControl?: boolean;
}): Buffer {
  const message: Record<string, unknown> = {
    t: 'hello',
    v: RELAY_PROTOCOL_VERSION,
    clientPubJwk: reduceEcPublicJwk(input.clientPubJwk),
    nonce: input.nonceB64url,
  };
  if (input.batch === true) message.batch = true;
  if (input.flowControl === true) message.flowControl = true;
  return Buffer.from(JSON.stringify(message), 'utf8');
}

export function encodeHandshakeReady(input: {
  batch?: boolean;
  flowControl?: boolean;
}): Buffer {
  const message: Record<string, unknown> = { t: 'ready', v: RELAY_PROTOCOL_VERSION };
  if (input.batch === true) message.batch = true;
  if (input.flowControl === true) message.flowControl = true;
  return Buffer.from(JSON.stringify(message), 'utf8');
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

export function decodeHandshakeHello(text: Buffer): DecodedHello | null {
  try {
    const parsed = JSON.parse(text.toString('utf8')) as (Partial<DecodedHello> & { v?: unknown }) | null;
    if (!parsed || typeof parsed !== 'object' || parsed.t !== 'hello' || parsed.v !== RELAY_PROTOCOL_VERSION) return null;
    if (!isShapedJwk(parsed.clientPubJwk) || typeof parsed.nonce !== 'string' || parsed.nonce === '') return null;
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

export function decodeHandshakeReady(text: Buffer): DecodedReady | null {
  try {
    const parsed = JSON.parse(text.toString('utf8')) as (Partial<DecodedReady> & { v?: unknown }) | null;
    if (!parsed || typeof parsed !== 'object' || parsed.t !== 'ready' || parsed.v !== RELAY_PROTOCOL_VERSION) return null;
    return { t: 'ready', batch: parsed.batch === true, flowControl: parsed.flowControl === true };
  } catch {
    return null;
  }
}

function isShapedJwk(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const jwk = value as Partial<RelayJwk>;
  return jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && jwk.x.length > 0
    && typeof jwk.y === 'string' && jwk.y.length > 0;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new Error('invalid base64url length');
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
