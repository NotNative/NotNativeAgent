// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 100_000;
const BLOCK = 512;

function octal(value, length) {
  const text = Math.max(0, value).toString(8).padStart(length - 1, '0');
  if (text.length >= length) throw new Error('managed-bundle-header-overflow');
  return `${text}\0`;
}

function safeArchivePath(value) {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')
    || Buffer.byteLength(normalized) > 100 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('managed-bundle-path-invalid');
  }
  return normalized;
}

function tarEntry(name, bytes) {
  const header = Buffer.alloc(BLOCK, 0);
  let offset = 0;
  function write(text, size) { header.write(text, offset, size, 'utf8'); offset += size; }
  write(safeArchivePath(name), 100);
  write(octal(0o600, 8), 8); // private by default; directories need traversal bits.
  write(octal(0, 8), 8); write(octal(0, 8), 8);
  write(octal(bytes.length, 12), 12);
  write(octal(Math.floor(Date.now() / 1000), 12), 12);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
  return padding ? [header, bytes, Buffer.alloc(padding)] : [header, bytes];
}

function walkFiles(root, relative = '') {
  const absolute = path.join(root, relative);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) throw new Error('managed-bundle-symlink-rejected');
  if (info.isFile()) return [{ absolute, relative: relative.replaceAll('\\', '/'), size: info.size }];
  if (!info.isDirectory()) throw new Error('managed-bundle-non-file-rejected');
  return readdirSync(absolute).sort().flatMap((name) => walkFiles(root, path.join(relative, name)));
}

function sourceFile(name, absolute) {
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) throw new Error('managed-bundle-symlink-rejected');
  if (!info.isFile()) throw new Error('managed-bundle-non-file-rejected');
  return { name, absolute, size: info.size };
}

/** Create a platform-neutral payload from the already-verified Electron build. */
export function createManagedSshBundle({ serverBundlePath, settingsRegistryPath, webDistPath, maxBytes = MAX_BUNDLE_BYTES }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BUNDLE_BYTES) {
    throw new Error('managed-bundle-limit-invalid');
  }
  const entries = [
    sourceFile('server.mjs', serverBundlePath),
    sourceFile('settings-registry.json', settingsRegistryPath),
    { name: 'package.json', bytes: Buffer.from('{"private":true,"type":"module","dependencies":{"node-pty":"^1.1.0"},"trustedDependencies":["node-pty"]}\n') },
    { name: 'start-managed.mjs', bytes: Buffer.from([
      "const { startServer } = await import('./server.mjs');",
      'const server = await startServer();',
      'console.log(`NOTNATIVE_READY_PORT=${server.port}`);',
      "process.once('SIGTERM', () => { server.dispose(); process.exit(0); });",
      "process.once('SIGINT', () => { server.dispose(); process.exit(0); });",
      '',
    ].join('\n')) },
    ...walkFiles(webDistPath).map(({ absolute, relative, size }) => ({ name: `web-dist/${relative}`, absolute, size })),
  ];
  const seen = new Set();
  let total = BLOCK * 2; // tar end markers count toward the memory/output bound.
  for (const entry of entries) {
    entry.name = safeArchivePath(entry.name);
    if (seen.has(entry.name)) throw new Error('managed-bundle-path-collision');
    seen.add(entry.name);
    if (seen.size > MAX_BUNDLE_ENTRIES) throw new Error('managed-bundle-too-many-files');
    entry.size ??= entry.bytes.length;
    const paddedSize = Math.ceil(entry.size / BLOCK) * BLOCK;
    total += BLOCK + paddedSize;
    if (total > maxBytes) throw new Error('managed-bundle-too-large');
  }

  const chunks = entries.flatMap((entry) => {
    const bytes = entry.bytes ?? readFileSync(entry.absolute);
    if (bytes.length !== entry.size) throw new Error('managed-bundle-source-changed');
    return tarEntry(entry.name, bytes);
  });
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

export const MANAGED_BUNDLE_LIMIT_BYTES = MAX_BUNDLE_BYTES;
