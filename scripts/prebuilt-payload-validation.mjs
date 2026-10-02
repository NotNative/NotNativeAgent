// SPDX-License-Identifier: Apache-2.0
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inventory, noLinks, validateEntries, transferFile, payloadTotal, within, PAYLOAD_LIMITS } from './payload-files.mjs';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
async function readBounded(path, limit) {
  await noLinks(path);
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('payload-manifest-size');
    const bytes = Buffer.alloc(info.size + 1); let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break; count += read.bytesRead;
    }
    if (count !== info.size) throw new Error('payload-manifest-changed');
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}
function validateManifest(value) {
  if (!exact(value, ['schema_version', 'version', 'platform', 'architecture', 'files']) || value.schema_version !== '1.0'
    || !/^\d{8}-[1-9]\d{0,5}$/u.test(value.version) || value.platform !== 'win32' || value.architecture !== 'x64'
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > PAYLOAD_LIMITS.files) throw new Error('payload-manifest-invalid');
  let total = 0;
  for (const entry of value.files) {
    if (!exact(entry, ['path', 'bytes', 'sha256']) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error('payload-manifest-entry-invalid');
    total = payloadTotal(total, entry.bytes);
  }
  const sorted = validateEntries(value.files);
  if (sorted.some((entry, index) => entry.path !== value.files[index].path)) throw new Error('payload-manifest-order');
}
export async function verifyPrebuiltPayload(input) {
  const root = await noLinks(input), bytes = await readBounded(join(root, 'NND_PAYLOAD.json'), 32 * 1024 * 1024);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); validateManifest(manifest);
  const entries = validateEntries((await inventory(root)).filter((entry) => entry.path !== 'NND_PAYLOAD.json'));
  if (entries.length !== manifest.files.length) throw new Error('payload-inventory-mismatch');
  for (const [index, entry] of entries.entries()) {
    if (entry.path !== manifest.files[index].path) throw new Error('payload-inventory-mismatch');
    await transferFile(entry.source, null, manifest.files[index]);
  }
  const packageEntry = manifest.files.find((entry) => entry.path === 'package.json');
  const versionEntry = manifest.files.find((entry) => entry.path === 'VERSION');
  if (!packageEntry || packageEntry.bytes > 65536 || !versionEntry || versionEntry.bytes > 128) throw new Error('payload-package-identity-invalid');
  const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(join(root, 'package.json'), 65536)));
  if (info.name !== 'notnative-desktop' || info.type !== 'module' || info.nnd_version !== manifest.version
    || info.version !== manifest.version.replace('-', '.0.') || (await readBounded(join(root, 'VERSION'), 128)).toString('utf8').trim() !== manifest.version) throw new Error('payload-package-identity-invalid');
  return { root, bytes, manifest, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export async function copyPrebuiltPayload(source, destination) {
  const verified = await verifyPrebuiltPayload(source), target = await noLinks(destination);
  if (within(verified.root, target) || within(target, verified.root) || (await readdir(target)).length) throw new Error('payload-copy-target-invalid');
  for (const entry of verified.manifest.files) await transferFile(join(verified.root, entry.path), join(target, entry.path), entry);
  await transferFile(join(verified.root, 'NND_PAYLOAD.json'), join(target, 'NND_PAYLOAD.json'), {
    bytes: verified.bytes.length, sha256: verified.sha256,
  });
  const after = await verifyPrebuiltPayload(target), sourceAfter = await verifyPrebuiltPayload(source);
  if (after.sha256 !== verified.sha256 || sourceAfter.sha256 !== verified.sha256) throw new Error('payload-copy-identity-changed');
  return after;
}
