// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ContractError } from './ids.js';
import { PRODUCT_NAME, VERSION } from './product.js';

export const UPDATE_REPOSITORY = Object.freeze({ owner: 'NotNative', repo: 'NotNativeAgent' });
export const UPDATE_BRANCH = 'main';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const VERSION_PATTERN = /^(?:v)?(\d{8})-(\d+)$/u;

export async function checkForUpdate(options) {
  const statePath = options.statePath;
  const currentVersion = options.currentVersion ?? VERSION;
  const now = options.now ?? Date.now();
  const intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const prior = await readUpdateState(statePath);
  if (!options.force && prior && now - Date.parse(prior.checked_at) < intervalMs) {
    return updateAvailability(prior, currentVersion, true);
  }
  let state;
  try {
    const latest = await fetchRepositoryVersion(options.fetchImpl ?? globalThis.fetch, options.timeoutMs ?? 3000);
    state = {
      format: 1, checked_at: new Date(now).toISOString(), status: 'ready',
      latest_version: latest.version, latest_ref: latest.ref, latest_tag: null, latest_sha: latest.sha,
    };
  } catch (error) {
    state = {
      format: 1, checked_at: new Date(now).toISOString(), status: 'unavailable',
      error_code: stableUpdateError(error), latest_version: prior?.latest_version ?? null,
      latest_ref: prior?.latest_ref ?? null, latest_tag: prior?.latest_tag ?? null,
      latest_sha: prior?.latest_sha ?? null,
    };
  }
  await writeUpdateState(statePath, state);
  return updateAvailability(state, currentVersion, false);
}

export async function readUpdateState(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.format !== 1 || typeof value.checked_at !== 'string') return null;
    return Object.freeze(value);
  } catch { return null; }
}

export async function installAvailableUpdate(options) {
  const paths = options.paths;
  const availability = await checkForUpdate({
    statePath: paths.updateState, currentVersion: options.currentVersion ?? VERSION,
    fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? 10_000, force: true,
  });
  if (!availability.available) return Object.freeze({ ...availability, installed: false });
  const marker = await readInstallMarker(options.installMarkerPath ?? defaultInstallMarkerPath());
  const lockPath = join(paths.updateRoot, 'update.lock');
  await mkdir(paths.updateRoot, { recursive: true, mode: 0o700 });
  const lock = await acquireUpdateLock(lockPath);
  let stageRoot = null;
  let backupRoot = null;
  try {
    stageRoot = join(paths.updateRoot, `stage-${process.pid}-${Date.now()}`);
    await mkdir(stageRoot, { recursive: false, mode: 0o700 });
    const archivePath = join(stageRoot, 'source.tar.gz');
    await downloadArchive(availability.latest_sha, archivePath, options.fetchImpl ?? globalThis.fetch, options.timeoutMs ?? 60_000);
    await validateArchive(archivePath, options.runProcess);
    const extractRoot = join(stageRoot, 'source');
    await mkdir(extractRoot, { recursive: false, mode: 0o700 });
    await runChecked('tar', ['-xzf', archivePath, '-C', extractRoot], options.runProcess, 'update_extract_failed');
    const sourceRoot = await singleExtractedDirectory(extractRoot);
    await validateSource(sourceRoot, availability.latest_version);
    const installedRoot = resolve(marker.install_root, 'installed');
    assertChild(installedRoot, marker.install_root);
    if (await exists(installedRoot)) {
      backupRoot = join(paths.updateRoot, `rollback-${VERSION}-${Date.now()}`);
      await cp(installedRoot, backupRoot, { recursive: true, errorOnExist: true });
    }
    try {
      await invokeInstaller(sourceRoot, marker, options.runProcess);
      await verifyInstalledVersion(marker, availability.latest_version, options.runProcess);
    } catch (error) {
      if (backupRoot && await exists(backupRoot)) {
        await rm(installedRoot, { recursive: true, force: true });
        await rename(backupRoot, installedRoot);
        backupRoot = null;
      }
      throw error;
    }
    if (backupRoot) await rm(backupRoot, { recursive: true, force: true });
    await writeUpdateState(paths.updateState, {
      format: 1, checked_at: new Date().toISOString(), status: 'ready',
      latest_version: availability.latest_version, latest_ref: availability.latest_ref,
      latest_tag: availability.latest_tag,
      latest_sha: availability.latest_sha, installed_at: new Date().toISOString(),
    });
    return Object.freeze({ ...availability, installed: true });
  } finally {
    if (stageRoot) await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    if (backupRoot) await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  if (a.date !== b.date) return a.date - b.date;
  return a.sequence - b.sequence;
}

export function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value));
  if (!match) throw new ContractError('update_version_invalid', 'NNA update version is invalid');
  return Object.freeze({ version: `${match[1]}-${Number(match[2])}`, date: Number(match[1]), sequence: Number(match[2]) });
}

export function defaultInstallMarkerPath(environment = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA;
    if (!local || !isAbsolute(local)) throw new ContractError('update_installation_missing', 'LOCALAPPDATA is unavailable');
    return join(local, PRODUCT_NAME, 'install.json');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', PRODUCT_NAME, 'install.json');
  return join(environment.XDG_DATA_HOME || join(home, '.local', 'share'), 'not-native-agent', 'install.json');
}

async function fetchRepositoryVersion(fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== 'function') throw new ContractError('update_network_unavailable', 'Fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = `https://api.github.com/repos/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}`;
    const commitResponse = await fetchImpl(`${base}/commits/${UPDATE_BRANCH}`, {
      signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': `NotNativeAgent/${VERSION}` },
    });
    if (!commitResponse.ok) throw new ContractError('update_check_failed', `repository query returned HTTP ${commitResponse.status}`);
    const commit = await commitResponse.json();
    const sha = commit?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/u.test(sha)) {
      throw new ContractError('update_response_invalid', 'repository query returned an invalid commit');
    }
    const versionResponse = await fetchImpl(`${base}/contents/VERSION?ref=${sha}`, {
      signal: controller.signal, headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': `NotNativeAgent/${VERSION}` },
    });
    if (!versionResponse.ok) throw new ContractError('update_check_failed', `VERSION query returned HTTP ${versionResponse.status}`);
    const parsed = parseVersion((await versionResponse.text()).trim());
    return Object.freeze({ ...parsed, ref: UPDATE_BRANCH, sha });
  } finally { clearTimeout(timer); }
}

function updateAvailability(state, currentVersion, cached) {
  const available = state.latest_version ? compareVersions(state.latest_version, currentVersion) > 0 : false;
  return Object.freeze({
    status: state.status, checked_at: state.checked_at, cached, current_version: currentVersion,
    latest_version: state.latest_version, latest_ref: state.latest_ref ?? null,
    latest_tag: state.latest_tag, latest_sha: state.latest_sha,
    available, error_code: state.error_code ?? null,
  });
}

async function writeUpdateState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

async function acquireUpdateLock(path) {
  try { return await open(path, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new ContractError('update_in_progress', 'another NNA update is already running');
    throw error;
  }
}

async function readInstallMarker(path) {
  let marker;
  try { marker = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new ContractError('update_installation_missing', 'NNA installation marker was not found'); }
  if (marker?.product !== PRODUCT_NAME || !isAbsolute(marker.install_root) || !isAbsolute(marker.data_root) || !isAbsolute(marker.node)) {
    throw new ContractError('update_installation_invalid', 'NNA installation marker is invalid');
  }
  return marker;
}

async function downloadArchive(sha, destination, fetchImpl, timeoutMs) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://codeload.github.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/tar.gz/${sha}`, {
      signal: controller.signal, headers: { 'User-Agent': `NotNativeAgent/${VERSION}` },
    });
    if (!response.ok || !response.body) throw new ContractError('update_download_failed', `source download returned HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new ContractError('update_archive_too_large', 'update archive exceeds its size limit');
    const file = await open(destination, 'wx', 0o600); let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_ARCHIVE_BYTES) throw new ContractError('update_archive_too_large', 'update archive exceeds its size limit');
        await file.write(chunk);
      }
    } finally { await file.close(); }
  } finally { clearTimeout(timer); }
}

async function validateArchive(path, runProcess) {
  const result = await runChecked('tar', ['-tzf', path], runProcess, 'update_archive_invalid');
  const entries = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.length > 20_000) throw new ContractError('update_archive_invalid', 'update archive entry count is invalid');
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new ContractError('update_archive_escape', 'update archive contains an unsafe path');
    }
  }
}

async function singleExtractedDirectory(root) {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) throw new ContractError('update_archive_invalid', 'update archive root is invalid');
  return join(root, entries[0].name);
}

async function validateSource(root, expectedVersion) {
  const embedded = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (embedded !== expectedVersion || manifest.name !== 'not-native-agent' || manifest.nna_version !== expectedVersion) {
    throw new ContractError('update_identity_mismatch', 'downloaded source identity does not match the selected tag');
  }
  await access(join(root, process.platform === 'win32' ? 'install.ps1' : 'install.sh'), constants.R_OK);
}

async function invokeInstaller(sourceRoot, marker, runProcess) {
  if (process.platform === 'win32') {
    await runChecked('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(sourceRoot, 'install.ps1'),
      '-SourceRoot', sourceRoot, '-InstallRoot', marker.install_root, '-DataRoot', marker.data_root,
      '-SkipProviderSetup', '-SkipWebSearchSetup', '-SkipPlaywrightSetup', '-SkipGatewaySetup', '-SkipRipgrepSetup',
    ], runProcess, 'update_install_failed', { inherit: true });
  } else {
    await runChecked('sh', [join(sourceRoot, 'install.sh'), '--source', sourceRoot, '--install-root', marker.install_root,
      '--data-root', marker.data_root, '--skip-provider-setup', '--skip-websearch-setup', '--skip-playwright-setup',
      '--skip-gateway-setup', '--skip-ripgrep-setup'], runProcess, 'update_install_failed', { inherit: true });
  }
}

async function verifyInstalledVersion(marker, expectedVersion, runProcess) {
  const cli = join(marker.install_root, 'installed', 'src', 'cli.js');
  const result = await runChecked(marker.node, ['--disable-warning=ExperimentalWarning', cli, '--version'], runProcess, 'update_verification_failed');
  if (result.stdout.trim() !== expectedVersion) throw new ContractError('update_verification_failed', 'installed NNA version does not match the selected update');
}

async function runChecked(command, args, runProcess, code, options = {}) {
  const runner = runProcess ?? spawnResult;
  const result = await runner(command, args, options);
  if (result.code !== 0) throw new ContractError(code, `${basename(command)} exited with code ${result.code}`);
  return result;
}

function spawnResult(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { if (stdout.length < 2_000_000) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 200_000) stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function assertChild(path, parent) {
  const resolvedPath = resolve(path); const resolvedParent = resolve(parent);
  if (resolvedPath === resolvedParent || !resolvedPath.startsWith(`${resolvedParent}${sep}`)) {
    throw new ContractError('update_path_unsafe', 'update target is outside the installation root');
  }
}

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
function stableUpdateError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('update_')) return error.code;
  if (error?.name === 'AbortError') return 'update_check_timeout';
  return 'update_check_unavailable';
}
