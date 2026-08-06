// SPDX-License-Identifier: Apache-2.0
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ContractError } from './ids.js';

const MANIFEST_LIMIT = 64 * 1024;
const validatedActivations = new WeakSet();

export async function validateNnoBrokerActivation(installRoot) {
  if (typeof installRoot !== 'string' || !installRoot.trim() || !isAbsolute(installRoot.trim())) {
    throw new ContractError('nno_install_required', 'secret broker API requires an absolute NNA_NNO_INSTALL_ROOT for an installed NNO deployment');
  }
  const root = await realpath(installRoot.trim()).catch(() => null);
  if (!root || !(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ContractError('nno_install_invalid', 'NNA_NNO_INSTALL_ROOT does not identify an installed NNO deployment');
  }
  const manifestPath = join(root, 'nna-integration', 'nno-hosted', 'integration.json');
  const actualManifest = await realpath(manifestPath).catch(() => null);
  if (!actualManifest || escapes(root, actualManifest)) {
    throw new ContractError('nno_broker_activation_missing', 'installed NNO integration does not activate the secret broker API');
  }
  const metadata = await stat(actualManifest);
  if (!metadata.isFile() || metadata.size > MANIFEST_LIMIT) {
    throw new ContractError('nno_broker_activation_invalid', 'installed NNO broker activation manifest is invalid');
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(actualManifest, 'utf8')); }
  catch { throw new ContractError('nno_broker_activation_invalid', 'installed NNO broker activation manifest is invalid'); }
  if (manifest?.id !== 'nno-hosted' || manifest?.ownership !== 'nno' || manifest?.scope !== 'nno-child-only'
    || manifest?.nna_secret_broker_protocol !== '1.0') {
    throw new ContractError('nno_broker_activation_incompatible', 'installed NNO integration does not support NNA secret broker protocol 1.0');
  }
  const activation = Object.freeze({ installRoot: root, manifestPath: actualManifest, protocol: '1.0' });
  validatedActivations.add(activation);
  return activation;
}

export function assertNnoBrokerActivation(activation) {
  if (!activation || !validatedActivations.has(activation)) {
    throw new ContractError('nno_broker_activation_required', 'secret broker API is dormant until an installed NNO integration activates it');
  }
  return activation;
}

function escapes(root, target) {
  const path = relative(root, target);
  return path === '..' || path.startsWith(`..\\`) || path.startsWith('../') || isAbsolute(path);
}
