// SPDX-License-Identifier: Apache-2.0
/**
 * Tray icon generator (P12a tray slice). Emits small system-tray PNGs with
 * ZERO dependencies: a raw PNG encoder (zlib via node:zlib, manual CRC32)
 * drawing a dark disc with a state ring —
 *   running: teal ring          stopped: gray ring
 * Assets land in packages/electron/assets/ and are consumed by tray.mjs.
 * Run: node scripts/electron-tray-icon.mjs  (idempotent)
 */
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve(import.meta.dirname, '..', 'packages', 'electron', 'assets');
const SIZE = 32;

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Pixels as [r,g,b,a]; scanlines are filter-0 prefixed rows. */
function encodePng(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  let offset = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const [r, g, b, a] = pixels(y * SIZE + x);
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = a;
      offset += 4;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function discPixel(ringHex) {
  const ring = [
    parseInt(ringHex.slice(1, 3), 16), parseInt(ringHex.slice(3, 5), 16), parseInt(ringHex.slice(5, 7), 16),
  ];
  const center = (SIZE - 1) / 2;
  return (index) => {
    const x = index % SIZE;
    const y = Math.floor(index / SIZE);
    const distance = Math.hypot(x - center, y - center);
    if (distance > 14.5) return [0, 0, 0, 0];
    if (distance >= 11.5) return [...ring, 255];
    if (distance > 10.5) return [...ring, 90]; // soft inner edge
    return [0x0c, 0x0a, 0x09, 245]; // app background disc
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const states = { running: '#2dd4bf', stopped: '#6b7280' };
for (const [name, hex] of Object.entries(states)) {
  const file = path.join(OUT_DIR, `tray-${name}.png`);
  fs.writeFileSync(file, encodePng(discPixel(hex)));
  process.stdout.write(`tray icon written: ${file}\n`);
}
