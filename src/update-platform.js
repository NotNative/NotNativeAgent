// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { ContractError } from './ids.js';

async function observe(marker, runProcess, args) {
  const result = await runProcess(marker.node, ['--disable-warning=ExperimentalWarning',
    join(marker.install_root, 'installed', 'src', 'cli.js'), ...args], {
    env: { ...process.env, NNA_HOME: marker.data_root },
  });
  if (result.code !== 0) throw new ContractError('update_platform_unverified', `Cannot verify ${args.join(' ')} during update`);
  try { return result.stdout.trim() ? JSON.parse(result.stdout) : null; }
  catch { throw new ContractError('update_platform_unverified', 'Platform observation returned invalid JSON'); }
}

export async function observeUpdatePlatform(marker, runProcess, platform = process.platform) {
  if (platform !== 'win32') return null;
  const status = await observe(marker, runProcess, ['desktop', 'status']);
  if (status === null) return null;
  if (typeof status.running !== 'boolean' || typeof status.enabled !== 'boolean'
    || typeof status.login?.installed !== 'boolean' || typeof status.root !== 'string'
    || status.running && typeof status.service?.instance_id !== 'string') {
    throw new ContractError('update_platform_unverified', 'Desktop service state is unknown; update was not verified');
  }
  return status;
}

export async function verifyDesktopUpdateSource(root, expectedVersion, before) {
  if (!before) return;
  try {
    const version = (await readFile(join(root, 'desktop', 'VERSION'), 'utf8')).trim();
    const manifest = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'));
    await access(join(root, 'desktop', 'install.cmd'));
    if (version !== expectedVersion || manifest.desktop_version !== expectedVersion) throw new Error('version');
  } catch {
    throw new ContractError('update_desktop_source_invalid', 'Selected update lacks its matching registered desktop payload; existing files were preserved');
  }
}

export async function verifyUpdatePlatform(marker, expectedVersion, before, runProcess, platform = process.platform) {
  if (platform !== 'win32') return null;
  const after = await observeUpdatePlatform(marker, runProcess, platform);
  if (!before && !after) return null;
  const registration = await observe(marker, runProcess, ['desktop', 'package', 'status']);
  const sameRoot = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
  if (!after || registration?.registered !== true || registration.valid !== true
    || registration.version !== expectedVersion || after.version !== expectedVersion
    || typeof registration.root !== 'string' || !sameRoot(registration.root, after.root)
    || before && (!sameRoot(before.root, after.root) || after.running !== before.running
      || after.enabled !== before.enabled || after.login.installed !== before.login.installed)
    || after.running && (!['ready', 'setup_required'].includes(after.service.service_state) || after.service.package_version !== expectedVersion
      || before?.running && after.service.instance_id === before.service.instance_id)) {
    throw new ContractError('update_platform_unverified', 'Desktop version, registration or service state did not match the completed NNA update; run the selected source installer to repair');
  }
  return after;
}
