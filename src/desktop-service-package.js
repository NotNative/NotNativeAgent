// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ContractError } from './ids.js';
import { assertDesktopActivationCompatibility, validateDesktopManifestExtensions } from './desktop-manifest-extensions.js';

const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
async function packageFile(root, path) {
  const actual = await realpath(join(root, path)).catch(() => null);
  const part = actual && relative(root, actual);
  if (!actual || isAbsolute(part) || part === '..' || part.startsWith('../') || part.startsWith('..\\')) {
    throw new ContractError('desktop_package_incomplete', 'desktop service artifact escapes or is missing from its package');
  }
  const metadata = await stat(actual);
  if (!metadata.isFile() || metadata.size > MAX_BUNDLE_BYTES) {
    throw new ContractError('desktop_package_incomplete', 'desktop service artifact is not a bounded regular file');
  }
  return actual;
}
async function bundleDigest(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  // Security: enforce the byte limit while reading, including concurrent file growth.
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.length;
    if (bytes > MAX_BUNDLE_BYTES) throw new ContractError('desktop_package_incomplete', 'desktop bundle exceeds its size bound');
    hash.update(chunk);
  }
  return hash.digest('hex');
}
export async function validateDesktopServiceArtifacts(root, manifest, host) {
  validateDesktopManifestExtensions(manifest);
  if (host !== undefined) assertDesktopActivationCompatibility(manifest, host);
  const activation = manifest.service_activation;
  const entrypoint = await packageFile(root, activation.entrypoint);
  const bundle = await packageFile(root, activation.bundle_identity.path);
  const servedBundle = await packageFile(root, 'packages/electron/dist-server/server.mjs');
  // Integrity: the digest must cover the server that this package actually serves,
  // rather than an unrelated helper selected by otherwise valid metadata.
  if (bundle !== servedBundle) {
    throw new ContractError('desktop_package_manifest_invalid', 'desktop bundle identity does not identify its server artifact');
  }
  if (await bundleDigest(bundle) !== activation.bundle_identity.sha256) {
    throw new ContractError('desktop_package_manifest_invalid', 'desktop service bundle digest does not match');
  }
  return Object.freeze({ entrypoint, bundle });
}
