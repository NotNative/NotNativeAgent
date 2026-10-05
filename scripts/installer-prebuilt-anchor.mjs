// SPDX-License-Identifier: Apache-2.0
/** Installs a fresh NND selection/launcher anchor after immutable activation succeeds. */
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNnaSelection } from './write-nna-selection.mjs';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';

const VALUES = /^[a-fA-F0-9]{64}$/u;
const OPERATIONS = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const VERSIONS = /^\d{8}-[1-9]\d{0,5}$/u;
const LAUNCHER_FILES = Object.freeze([
  'scripts/launch-selected-desktop.ps1',
  'scripts/launch-selected-desktop.mjs',
  'scripts/resolve-active-nnd-package.mjs',
  'packages/electron/native-service-client.mjs',
  'packages/electron/native-service-selection.mjs',
]);

function fail(code) { const error = new Error(code); error.code = code; throw error; }

function absolute(value, code) {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return resolve(value);
}

async function launcherSource(root, relativePath) {
  const path = resolve(root, relativePath);
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.size > 65536) fail('prebuilt_launcher_source_invalid');
  const pathInfo = await stat(path).catch(() => null);
  if (!pathInfo || pathInfo.ino !== info.ino || pathInfo.dev !== info.dev
    || pathInfo.size !== info.size) fail('prebuilt_launcher_source_invalid');
  const part = relative(root, path);
  if (part === '' || part.startsWith('..')) fail('prebuilt_launcher_path_invalid');
  return path;
}

async function ensureAbsent(path, code) {
  try { await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  fail(code);
}

// A prior anchor may only be replaced when it is a marked NND anchor bound to
// this exact installation identity; anything else stays untouched.
async function verifyRebindableAnchor(anchor, installationId, dataId, nnaIncarnation) {
  const bindingBytes = await readFile(join(anchor, 'nnd-anchor.json')).catch(() => null);
  if (!bindingBytes || bindingBytes.length > 16384) fail('prebuilt_anchor_present');
  let binding;
  try { binding = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bindingBytes)); }
  catch { fail('prebuilt_anchor_present'); }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || binding.schema_version !== '1.0'
    || binding.installation_id !== installationId || binding.data_id !== dataId) fail('prebuilt_anchor_present');
  // ADR 0070: a bound anchor whose NNA incarnation was replaced grants nothing.
  if (typeof binding.incarnation_id === 'string' && nnaIncarnation !== null
    && binding.incarnation_id !== nnaIncarnation) fail('prebuilt_anchor_present');
  return binding;
}

async function remove(path) {
  await rm(path, { recursive: true, force: true });
}

export async function installPrebuiltAnchor({
  anchor, sourceRoot, nnaRoot, installationId, dataId,
  packageRoot, version, payloadSha256, stageOperationId,
  activationOperationId, candidateSha256,
}) {
  anchor = absolute(anchor, 'prebuilt_anchor_invalid');
  sourceRoot = absolute(sourceRoot, 'prebuilt_launcher_source_invalid');
  nnaRoot = absolute(nnaRoot, 'prebuilt_nna_root_invalid');
  packageRoot = absolute(packageRoot, 'prebuilt_package_root_invalid');
  if (!/^nna_[a-f0-9]{64}$/u.test(installationId ?? '') || !/^data_[a-f0-9]{64}$/u.test(dataId ?? '')
    || !VALUES.test(payloadSha256 ?? '') || !VALUES.test(candidateSha256 ?? '')
    || !OPERATIONS.test(stageOperationId ?? '') || !VERSIONS.test(version ?? '')) {
    fail('prebuilt_anchor_identity_invalid');
  }
  const nnaIncarnation = readSelectedNativeRuntime(nnaRoot).incarnation_id;
  const sameRoot = (left, right) => left.toLowerCase() === right.toLowerCase();
  const overlaps = (left, right) => sameRoot(left, right) || right.startsWith(left + '\\') || left.startsWith(right + '\\');
  if (overlaps(anchor, nnaRoot) || overlaps(anchor, packageRoot)) fail('prebuilt_anchor_path_overlap');
  // Fresh install demands an absent target; an upgrade may only replace a
  // marked anchor bound to this same installation identity.
  const anchorExists = (await lstat(anchor).catch(() => null)) !== null;
  if (anchorExists) await verifyRebindableAnchor(anchor, installationId, dataId, nnaIncarnation);
  const parent = anchor.slice(0, Math.max(0, anchor.lastIndexOf('\\')));
  const temporary = join(parent, `.${anchor.split('\\').at(-1)}.${crypto.randomUUID()}.staging`);
  await mkdir(parent, { recursive: true });
  await mkdir(temporary, { recursive: true });
  try {
    for (const file of LAUNCHER_FILES) {
      await mkdir(join(temporary, file, '..'), { recursive: true });
      await copyFile(await launcherSource(sourceRoot, file), join(temporary, file));
    }
    await mkdir(join(temporary, 'packages', 'electron'), { recursive: true });
    await writeNnaSelection(temporary, nnaRoot, installationId, dataId);
    await writeFile(join(temporary, 'nnd-anchor.json'), `${JSON.stringify({
      schema_version: '1.0', nna_install_root: nnaRoot, nnd_package_root: packageRoot,
      version, payload_sha256: payloadSha256, stage_operation_id: stageOperationId,
      activation_operation_id: activationOperationId, candidate_sha256: candidateSha256,
      installation_id: installationId, data_id: dataId,
      ...(nnaIncarnation === null ? {} : { incarnation_id: nnaIncarnation }),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    let displaced = null;
    if (anchorExists) {
      displaced = join(parent, `.${anchor.split('\\').at(-1)}.${crypto.randomUUID()}.previous`);
      await rename(anchor, displaced);
    }
    try {
      await rename(temporary, anchor);
    } catch (error) {
      if (displaced) await rename(displaced, anchor).catch(() => undefined);
      throw error;
    }
    if (displaced) await remove(displaced);
    const installed = await readdir(anchor, { recursive: true });
    if (installed.filter(entry => /\.staging$/u.test(entry)).length) fail('prebuilt_anchor_staging_invalid');
    return { anchor, nnd_package_root: packageRoot, version };
  } catch (error) {
    await remove(temporary);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 13) fail('usage: installer-prebuilt-anchor.mjs ANCHOR SOURCE_ROOT NNA_ROOT NND_PACKAGE_ROOT INSTALLATION_ID DATA_ID VERSION STAGE_OPERATION_ID ACTIVATION_OPERATION_ID PAYLOAD_SHA256 CANDIDATE_SHA256');
  const [anchor, sourceRoot, nnaRoot, packageRoot, installationId, dataId, version,
    stageOperationId, activationOperationId, payloadSha256, candidateSha256] = process.argv.slice(2);
  await installPrebuiltAnchor({ anchor, sourceRoot, nnaRoot, installationId, dataId,
    packageRoot, version, payloadSha256, stageOperationId, activationOperationId,
    candidateSha256 }).catch(error => {
      console.error(error instanceof Error ? error.message : 'unknown prebuilt anchor failure');
      process.exitCode = 1;
    });
}
