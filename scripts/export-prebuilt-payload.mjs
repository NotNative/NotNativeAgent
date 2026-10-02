// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeInstalledServiceManifest } from './installed-service-package.mjs';
import { payloadPlan, verifyBuildStamp, verifyElectronDependency } from './payload-export-plan.mjs';
import { inventory, validateEntries, transferFile, createDestination, cleanupDestination, noLinks, payloadTotal } from './payload-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export async function exportPrebuiltPayload(destination, { sourceRoot = ROOT } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('payload-export-requires-windows-x64');
  sourceRoot = await noLinks(sourceRoot);
  const initialStamp = await verifyBuildStamp(sourceRoot);
  const plan = await payloadPlan(sourceRoot);
  const owned = await createDestination(destination, [plan.root, plan.dependency]);
  try {
    for (const entry of plan.files) await transferFile(entry.source, join(owned.path, entry.path), entry.expected);
    await writeFile(join(owned.path, 'VERSION'), `${plan.version}\n`, { flag: 'wx' });
    await writeFile(join(owned.path, 'package.json'), `${JSON.stringify({ name: 'notnative-desktop', private: true,
      type: 'module', version: plan.packageInfo.version, nnd_version: plan.version })}\n`, { flag: 'wx' });
    await writeFile(join(owned.path, 'packages/electron/install-mode.txt'), 'script', { flag: 'wx' });
    await writeInstalledServiceManifest(owned.path);
    if (await verifyBuildStamp(plan.root) !== initialStamp) throw new Error('payload-source-changed');
    // Invariant: runtime dependencies are outside the source stamp, so verify every planned source again.
    for (const entry of plan.files) await transferFile(entry.source, null, entry.expected);
    await verifyElectronDependency(plan);
    const manifest = await writePayloadManifest(owned.path, plan.version);
    return { root: owned.path, version: plan.version, files: manifest.files.length,
      sha256: createHash('sha256').update(await readFile(join(owned.path, 'NND_PAYLOAD.json'))).digest('hex') };
  } catch (error) {
    try { await cleanupDestination(owned); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Payload export failed; cleanup ownership could not be verified'); }
    throw error;
  }
}
export async function writePayloadManifest(root, version) {
  const entries = validateEntries(await inventory(root));
  const files = []; let total = 0;
  for (const entry of entries) {
    const identity = await transferFile(entry.source);
    total = payloadTotal(total, identity.bytes);
    files.push({ path: entry.path, ...identity });
  }
  const manifest = { schema_version: '1.0', version, platform: 'win32', architecture: 'x64', files };
  await writeFile(join(root, 'NND_PAYLOAD.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: export-prebuilt-payload.mjs ABSOLUTE_NEW_DIRECTORY');
  const result = await exportPrebuiltPayload(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
