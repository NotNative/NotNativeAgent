// SPDX-License-Identifier: Apache-2.0
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ContractError } from './ids.js';

const MANIFEST_LIMIT = 64 * 1024;
const validated = new WeakSet();

export async function validateNnoIntegrationActivation(installRoot) {
  if (typeof installRoot !== 'string' || !installRoot.trim() || !isAbsolute(installRoot.trim())) {
    throw new ContractError('nno_install_required', 'integration service requires an absolute NNA_NNO_INSTALL_ROOT');
  }
  const root = await realpath(installRoot.trim()).catch(() => null);
  if (!root || !(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ContractError('nno_install_invalid', 'NNA_NNO_INSTALL_ROOT does not identify an installed NNO deployment');
  }
  const requested = join(root, 'nna-integration', 'nno-hosted', 'integration.json');
  const manifestPath = await realpath(requested).catch(() => null);
  if (!manifestPath || escapes(root, manifestPath)) {
    throw new ContractError('nno_integration_activation_missing', 'installed NNO integration does not activate the NNA integration service');
  }
  const metadata = await stat(manifestPath);
  if (!metadata.isFile() || metadata.size > MANIFEST_LIMIT) {
    throw new ContractError('nno_integration_activation_invalid', 'installed NNO integration manifest is invalid');
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new ContractError('nno_integration_activation_invalid', 'installed NNO integration manifest is invalid'); }
  const protocol = manifest?.nna_integration_protocol;
  if (manifest?.id !== 'nno-hosted' || manifest?.ownership !== 'nno'
    || manifest?.scope !== 'nno-child-only' || protocol !== '1.0') {
    throw new ContractError('nno_integration_activation_incompatible', 'installed NNO integration does not support NNA integration protocol 1.0');
  }
  if (manifest.deployment_id !== undefined && boundedId(manifest.deployment_id) === null) {
    throw new ContractError('nno_integration_activation_invalid', 'NNO integration deployment_id is invalid');
  }
  const activation = Object.freeze({
    installRoot: root, manifestPath, protocol: '1.0',
    deploymentId: boundedId(manifest.deployment_id) ?? 'hosted',
  });
  validated.add(activation);
  return activation;
}

export function assertNnoIntegrationActivation(activation) {
  if (!activation || !validated.has(activation)) {
    throw new ContractError('nno_integration_activation_required', 'integration service is dormant until an installed NNO integration activates it');
  }
  return activation;
}

function boundedId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value) ? value : null;
}

function escapes(root, target) {
  const path = relative(root, target);
  return path === '..' || path.startsWith(`..\\`) || path.startsWith('../') || isAbsolute(path);
}
