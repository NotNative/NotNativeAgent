// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, realpath, opendir, open, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, dirname, join, parse } from 'node:path';

export const PAYLOAD_LIMITS = Object.freeze({ files: 20000, fileBytes: 512 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024 });
export function payloadTotal(total, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > PAYLOAD_LIMITS.fileBytes
    || !Number.isSafeInteger(total) || total < 0 || total + bytes > PAYLOAD_LIMITS.totalBytes) throw new Error('payload-total-limit');
  return total + bytes;
}
export function payloadPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value || /[\\:\u0000-\u001f\u007f<>"|?*]/u.test(value)) throw new Error('payload-path-invalid');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)) throw new Error('payload-path-invalid');
  }
  return value;
}
export function within(root, path) {
  const part = relative(root, path);
  return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\');
}
export async function noLinks(path) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('payload-source-link');
  }
  return realpath(absolute);
}
async function makePlainParents(path) {
  if (!isAbsolute(path)) throw new Error('payload-target-absolute-required');
  const absolute = resolve(path), root = parse(absolute).root;
  const parts = relative(root, absolute).split(/[\\/]/u).filter(Boolean);
  if (parts.length > 256) throw new Error('payload-target-depth');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('payload-target-link');
  }
}
export async function inventory(root, prefix = '') {
  const canonical = await noLinks(root), pending = [{ directory: canonical, prefix }], files = [];
  let entries = 0;
  while (pending.length) {
    const item = pending.pop();
    for await (const entry of await opendir(item.directory)) {
      if (++entries > PAYLOAD_LIMITS.files * 2) throw new Error('payload-inventory-limit');
      const path = payloadPath(item.prefix ? `${item.prefix}/${entry.name}` : entry.name);
      const source = join(item.directory, entry.name), info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error('payload-source-link');
      if (info.isDirectory()) pending.push({ directory: source, prefix: path });
      else if (info.isFile() && info.nlink === 1) files.push({ path, source });
      else throw new Error('payload-source-type');
      // The sealed manifest itself is outside the manifest's 20,000-file inventory.
      if (files.length > PAYLOAD_LIMITS.files + 1) throw new Error('payload-file-limit');
    }
  }
  return files;
}
export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > PAYLOAD_LIMITS.files) throw new Error('payload-file-limit');
  const seen = new Set(), directories = new Set();
  for (const entry of entries) {
    const key = payloadPath(entry.path).toLowerCase();
    if (key === 'nnd_payload.json' || seen.has(key) || directories.has(key)) throw new Error('payload-duplicate-path');
    const parts = key.split('/'); parts.pop();
    while (parts.length) {
      const parent = parts.join('/');
      if (seen.has(parent)) throw new Error('payload-duplicate-path');
      directories.add(parent); parts.pop();
    }
    seen.add(key);
  }
  return [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function transferFile(source, target = null, expected = null) {
  await noLinks(source);
  const input = await open(source, 'r'), hash = createHash('sha256');
  let output, bytes = 0;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > PAYLOAD_LIMITS.fileBytes) throw new Error('payload-source-type-or-size');
    if (target) { await makePlainParents(dirname(target)); output = await open(target, 'wx', 0o600); }
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const read = await input.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead; if (bytes > PAYLOAD_LIMITS.fileBytes) throw new Error('payload-file-limit');
      const chunk = buffer.subarray(0, read.bytesRead); hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    const after = await input.stat(), current = await lstat(source);
    if (current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1
      || before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('payload-source-changed');
    const result = { bytes, sha256: hash.digest('hex') };
    if (expected && (expected.bytes !== bytes || expected.sha256 !== result.sha256)) throw new Error('payload-source-changed');
    await output?.sync(); return result;
  } finally { await input.close(); await output?.close(); }
}
export async function createDestination(destination, forbiddenRoots) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('payload-destination-absolute-required');
  const path = resolve(destination), parent = await noLinks(dirname(path));
  if (path !== join(parent, parse(path).base)) throw new Error('payload-destination-alias');
  payloadPath(parse(path).base);
  if (forbiddenRoots.some((root) => within(root, path) || within(path, root))) throw new Error('payload-destination-overlap');
  await mkdir(path); const identity = await lstat(path);
  return { path, parent, identity };
}
export async function cleanupDestination(owned) {
  const info = await lstat(owned.path), actual = await realpath(owned.path);
  if (info.isSymbolicLink() || info.ino !== owned.identity.ino || info.dev !== owned.identity.dev
    || actual !== owned.path || dirname(actual) !== owned.parent) throw new Error('payload-cleanup-ownership-lost');
  // Security: only this freshly-created directory is removed, after checking its exact identity and parent.
  await rm(actual, { recursive: true, force: false });
}
