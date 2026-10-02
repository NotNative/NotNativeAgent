// SPDX-License-Identifier: Apache-2.0
import { assertPayloadRuntime } from './nnd-payload-contract-runtime.js';
import { assertNndActivationCompatibility } from './nnd-manifest-extensions.js';
import { payloadError } from './nnd-payload-contract-files.js';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inventory, noLinks, validateEntries, transferFile, payloadTotal, within, PAYLOAD_LIMITS } from './nnd-payload-contract-files.js';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export async function readPayloadBytes(path, limit) {
  await noLinks(path);
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw payloadError('payload-manifest-size');
    const bytes = Buffer.alloc(info.size + 1); let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break; count += read.bytesRead;
    }
    if (count !== info.size) throw payloadError('payload-manifest-changed');
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}
export function validatePayloadManifest(value) {
  if (!exact(value, ['schema_version', 'version', 'platform', 'architecture', 'files']) || value.schema_version !== '1.0'
    || typeof value.version !== 'string' || !/^\d{8}-[1-9]\d{0,5}$/u.test(value.version) || value.platform !== 'win32' || value.architecture !== 'x64'
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > PAYLOAD_LIMITS.files) throw payloadError('payload-manifest-invalid');
  let total = 0;
  for (const entry of value.files) {
    if (!exact(entry, ['path', 'bytes', 'sha256']) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw payloadError('payload-manifest-entry-invalid');
    total = payloadTotal(total, entry.bytes);
  }
  const sorted = validateEntries(value.files);
  if (sorted.some((entry, index) => entry.path !== value.files[index].path)) throw payloadError('payload-manifest-order');
}
export async function verifyNndPayload(input, { signal, host } = {}) {
  try { return await verifyPayload(input,signal,host); }
  catch(error) {
    if(signal?.aborted) throw signal.reason;
    if(['nnd_payload_invalid','nnd_package_manifest_invalid','nnd_package_incompatible'].includes(error.code))throw error;
    throw payloadError('payload-unreadable-or-invalid');
  }
}
async function verifyPayload(input, signal, host) {
  const root = await noLinks(input), bytes = await readPayloadBytes(join(root, 'NND_PAYLOAD.json'), 32 * 1024 * 1024);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); validatePayloadManifest(manifest);
  const scanned=await inventory(root,'',signal);
  const parents=new Set();
  for(const file of manifest.files) { const parts=file.path.split('/');parts.pop();while(parts.length){parents.add(parts.join('/'));parts.pop();} }
  if(scanned.directories.some(path=>!parents.has(path))) throw payloadError('payload-extra-directory');
  const entries = validateEntries(scanned.filter((entry) => entry.path !== 'NND_PAYLOAD.json'));
  if (entries.length !== manifest.files.length) throw payloadError('payload-inventory-mismatch');
  for (const [index, entry] of entries.entries()) {
    if (entry.path !== manifest.files[index].path) throw payloadError('payload-inventory-mismatch');
    await transferFile(entry.source, null, manifest.files[index], signal);
  }
  const packageEntry = manifest.files.find((entry) => entry.path === 'package.json');
  const versionEntry = manifest.files.find((entry) => entry.path === 'VERSION');
  if (!packageEntry || packageEntry.bytes > 65536 || !versionEntry || versionEntry.bytes > 128) throw payloadError('payload-package-identity-invalid');
  const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readPayloadBytes(join(root, 'package.json'), 65536)));
  if (info.name !== 'notnative-desktop' || info.type !== 'module' || info.nnd_version !== manifest.version
    || info.version !== manifest.version.replace('-', '.0.') || (await readPayloadBytes(join(root, 'VERSION'), 128)).toString('utf8').trim() !== manifest.version) throw payloadError('payload-package-identity-invalid');
  await packageCompatibility(root, manifest, host, signal);
  await assertPayloadRuntime(root,manifest);
  return { root, bytes, manifest, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function packageCompatibility(root, payload, host, signal) {
  signal?.throwIfAborted();
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readPayloadBytes(join(root,'nna-integration/nnd-local/integration.json'),16384)));
  assertNndActivationCompatibility(manifest,host);
  if(manifest.version!==payload.version || manifest.service_activation.bundle_identity.path!=='packages/electron/dist-server/server.mjs') throw payloadError('payload-package-version');
  const entry=payload.files.find(item=>item.path===manifest.service_activation.entrypoint);
  const bundle=payload.files.find(item=>item.path===manifest.service_activation.bundle_identity.path);
  if(!entry || !bundle || bundle.sha256!==manifest.service_activation.bundle_identity.sha256
    || !payload.files.some(item=>item.path==='packages/web/dist/index.html')) throw payloadError('payload-service-artifacts');
}
export async function copyNndPayload(verified, destination, {signal,host}={}) {
  const target=await noLinks(destination);
  if(within(verified.root,target)||within(target,verified.root)||(await readdir(target)).length) throw payloadError('payload-copy-target-invalid');
  for(const entry of verified.manifest.files) {
    signal?.throwIfAborted();
    await transferFile(join(verified.root,entry.path),join(target,entry.path),entry,signal);
  }
  await transferFile(join(verified.root,'NND_PAYLOAD.json'),join(target,'NND_PAYLOAD.json'),{bytes:verified.bytes.length,sha256:verified.sha256},signal);
  const after=await verifyNndPayload(target,{signal,host}),sourceAfter=await verifyNndPayload(verified.root,{signal,host});
  if(after.sha256!==verified.sha256 || sourceAfter.sha256!==verified.sha256) throw payloadError('payload-copy-identity-changed');
  return after;
}
