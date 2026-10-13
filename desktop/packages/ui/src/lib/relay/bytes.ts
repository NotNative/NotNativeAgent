// SPDX-License-Identifier: Apache-2.0
/**
 * Relay shared wire primitives (doc 08 §3.1) — browser-safe byte helpers
 * for the client relay contract. Every relay client (web, desktop, mobile)
 * imports from here; the wire format is a numeric/byte contract never
 * renumbered. Pure Uint8Array + WebCrypto: no node:buffer, no DOM types,
 * so server-side cross-compat tests compile and run the same modules.
 */

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_HKDF_INFO = 'openchamber-relay-v1';

/** Byte-level helpers (no Buffer dependency). */
export function u8Concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

export function u8ReadUInt32BE(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] as number) << 24) | ((bytes[(offset + 1) as number] as number) << 16)
    | ((bytes[(offset + 2) as number] as number) << 8) | (bytes[(offset + 3) as number] as number)) >>> 0;
}

export function u8WriteUInt32BE(bytes: Uint8Array, value: number, offset: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

export function u8WriteBigUInt64BE(bytes: Uint8Array, value: bigint, offset: number): void {
  u8WriteUInt32BE(bytes, Number((value >> 32n) & 0xffffffffn), offset);
  u8WriteUInt32BE(bytes, Number(value & 0xffffffffn), offset + 4);
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    buffer = (buffer << 8) | (bytes[i] as number);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += BASE64URL_ALPHABET[(buffer >>> bits) & 0x3f];
    }
  }
  if (bits > 0) out += BASE64URL_ALPHABET[(buffer << (6 - bits)) & 0x3f];
  return out;
}

function decodeIndex(char: string): number {
  if (char === '+') return 62;
  if (char === '/') return 63;
  const index = BASE64URL_ALPHABET.indexOf(char);
  if (index < 0) throw new Error('invalid base64url character');
  return index;
}

/** Standard + URL-safe alphabets both decode; padding is tolerated. */
export function base64UrlToBytes(value: string): Uint8Array {
  let usableChars = 0;
  for (const char of value) {
    if (char === '=' || char === '\n' || char === '\r') continue;
    usableChars += 1;
  }
  if (usableChars % 4 === 1) throw new Error('invalid base64url length');
  const out = new Uint8Array(Math.floor((usableChars * 6) / 8));
  let index = 0;
  let buffer = 0;
  let collected = 0;
  for (const char of value) {
    if (char === '=' || char === '\n' || char === '\r') continue;
    buffer = (buffer << 6) | decodeIndex(char);
    collected += 6;
    if (collected >= 8) {
      collected -= 8;
      const byte = (buffer >>> collected) & 0xff;
      if (index < out.length) {
        out[index] = byte;
        index += 1;
      }
    }
  }
  return out;
}

const textEncoderSingleton = new TextEncoder();
const textDecoderSingleton = new TextDecoder('utf8');

export function utf8Bytes(text: string): Uint8Array {
  return textEncoderSingleton.encode(text);
}

export function utf8Text(bytes: Uint8Array): string {
  return textDecoderSingleton.decode(bytes);
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
