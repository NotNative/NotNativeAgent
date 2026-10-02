// SPDX-License-Identifier: Apache-2.0
/** Installed artifact admission shared by the installer and supervised GUI child. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNndManifestExtensions } from './nnd-manifest-extensions.js';
const MANIFEST = 'nna-integration/nnd-local/integration.json';
const BUNDLE = 'packages/electron/dist-server/server.mjs';
const ENTRY = 'scripts/serve-installed.mjs';
const METADATA_LIMIT = 65_536;

function contained(root, target) {
  const part = relative(root, target);
  return !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\');
}
async function artifact(root, path) {
  const actual = await realpath(join(root, path));
  if (!contained(root, actual)) throw new Error('Installed NND artifact escapes its package root');
  return actual;
}
async function boundedText(root, path) {
  const handle = await open(await artifact(root, path), 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Installed NND metadata must be a regular file');
    const buffer = Buffer.alloc(METADATA_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > METADATA_LIMIT) throw new Error('Installed NND metadata exceeds its size limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await handle.close(); }
}
async function bundleHash(root) {
  const handle = await open(await artifact(root, BUNDLE), 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !metadata.size || metadata.size > 128 * 1024 * 1024) {
      throw new Error('Installed NND bundle size or type is invalid');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65_536);
    let size = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
      if (size > 128 * 1024 * 1024) throw new Error('Installed NND bundle exceeds its size limit');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}
async function packageIdentity(rootInput) {
  if (typeof rootInput !== 'string' || !isAbsolute(rootInput)) throw new Error('NND package root must be absolute');
  const root = await realpath(rootInput);
  const info = JSON.parse(await boundedText(root, 'package.json'));
  const version = (await boundedText(root, 'VERSION')).trim();
  if (!/^\d{8}-[1-9]\d{0,5}$/u.test(version) || info.nnd_version !== version
    || typeof info.version !== 'string' || !/^\d{8}\.0\.[1-9]\d{0,5}$/u.test(info.version)) {
    throw new Error('Installed NND package versions are inconsistent');
  }
  if (info.version !== `${version.replace('-', '.0.')}`) throw new Error('Installed NND semantic version differs');
  await boundedText(root, ENTRY);
  const index = await open(await artifact(root, 'packages/web/dist/index.html'), 'r');
  try { if (!(await index.stat()).isFile()) throw new Error('Installed NND web entry is invalid'); }
  finally { await index.close(); }
  return { root, version, packageVersion: info.version, bundle: await artifact(root, BUNDLE),
    dist: await artifact(root, 'packages/web/dist') };
}
export async function validateInstalledNndService(rootInput) {
  const value = await packageIdentity(rootInput);
  const manifest = JSON.parse(await boundedText(value.root, MANIFEST));
  validateNndManifestExtensions(manifest);
  const activation = manifest.service_activation;
  if (manifest.version !== value.version || activation.entrypoint !== ENTRY
    || activation.bundle_identity.path !== BUNDLE || activation.bundle_identity.sha256 !== await bundleHash(value.root)
    || activation.platform !== process.platform || activation.architecture !== process.arch
    || Number(process.versions.node.split('.')[0]) < activation.runtime.minimum_major) {
    throw new Error('Installed NND service artifacts or runtime are incompatible');
  }
  return Object.freeze({ ...value, manifest });
}
export async function writeInstalledServiceManifest(rootInput) {
  const value = await packageIdentity(rootInput);
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('NND supervised installation requires Windows x64 or arm64');
  }
  const manifest = { id: 'nnd-local', ownership: 'nnd', scope: 'local-gui', nna_integration_protocol: '1.0',
    version: value.version, service_activation: {
      schema_version: '1.0', required_capabilities: ['service_supervision', 'setup_control_plane'],
      data_schemas: { nnd_catalog: 1, nnd_state: 1 }, platform: 'win32', architecture: process.arch,
      runtime: { name: 'node', minimum_major: 24 }, entrypoint: ENTRY,
      bundle_identity: { path: BUNDLE, sha256: await bundleHash(value.root) },
      authenticated_callbacks: { token_exchange: 'protected_stdin', protocol: '1.0' },
    } };
  validateNndManifestExtensions(manifest);
  // Security: validate each existing ancestor before creating anything below it.
  for (const path of ['nna-integration', 'nna-integration/nnd-local']) {
    await mkdir(join(value.root, path)).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    await artifact(value.root, path);
  }
  const directory = await artifact(value.root, 'nna-integration/nnd-local');
  const temporary = join(directory, `integration.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'integration.json'));
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: installed-service-package.mjs ABSOLUTE_NND_ROOT');
  await writeInstalledServiceManifest(process.argv[2]);
}
