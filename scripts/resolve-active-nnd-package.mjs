// SPDX-License-Identifier: Apache-2.0
/** Read-only prerequisite for a future stable launcher. This is not activation proof. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readNativeServiceSelection } from '../packages/electron/native-service-selection.mjs';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';
import { verifyPrebuiltPayload } from './prebuilt-payload-validation.mjs';
import { noLinks } from './payload-files.mjs';
import { validateInstalledNndService } from './installed-service-package.mjs';

const execute = promisify(execFile);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
function cleanEnvironment(dataRoot) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$|NNA_|NND_|NOTNATIVE_)/iu.test(name))), NNA_HOME: dataRoot };
}
async function nativeStatus(runtime) {
  try {
    const { stdout } = await execute(runtime.node, [runtime.cli, 'nnd', 'package', 'status'], {
      cwd: runtime.root, env: cleanEnvironment(runtime.dataRoot), windowsHide: true,
      shell: false, timeout: 10000, maxBuffer: 16384,
    });
    const status = JSON.parse(stdout);
    if (status?.registered !== true || status.valid !== true || typeof status.root !== 'string'
      || typeof status.version !== 'string' || Object.keys(status).sort().join(',') !== 'registered,root,valid,version') {
      throw new Error('native-package-inactive');
    }
    return status;
  } catch (error) {
    if (error.message === 'native-package-inactive') throw error;
    throw new Error('native-package-status-unavailable');
  }
}
function assertSlotPath(root, versions, status, verified) {
  if (key(dirname(root)) !== key(versions) || key(status.root) !== key(root)
    || status.version !== verified.manifest.version
    || basename(root).toLowerCase() !== `${verified.manifest.version}-${verified.sha256}`) {
    throw new Error('native-package-slot-mismatch');
  }
  for (const file of ['packages/electron/main.mjs', 'packages/electron/node_modules/electron/dist/electron.exe']) {
    if (!verified.manifest.files.some(entry => entry.path === file.replaceAll('\\', '/'))) {
      throw new Error('native-package-shell-incomplete');
    }
  }
}
async function shellFile(root, path) {
  const expected = join(root, path);
  const actual = await realpath(expected);
  const part = relative(root, actual);
  if (part === '..' || part.startsWith('..\\') || part.startsWith('../') || isAbsolute(part)
    || !(await stat(actual)).isFile()) throw new Error('native-package-shell-incomplete');
  return actual;
}
export async function resolveActiveNndPackage(selectionFile, sourceRoot = null) {
  if (typeof selectionFile !== 'string' || !isAbsolute(selectionFile)) throw new Error('native-selection-required');
  const selection = readNativeServiceSelection({ args: [], selectionFile });
  const runtime = readSelectedNativeRuntime(selection.installRoot);
  if (selection.installation_id !== runtime.installation_id || selection.data_id !== runtime.data_id) {
    throw new Error('native-selection-identity-changed');
  }
  const before = await nativeStatus(runtime);
  let root, executable, payloadSha256 = null;
  const source = sourceRoot === null ? null : await realpath(sourceRoot);
  if (source && key(before.root) === key(source)) {
    const verified = await validateInstalledNndService(source);
    if (before.version !== verified.version) throw new Error('native-package-source-mismatch');
    root = verified.root;
    executable = await shellFile(root, 'packages/electron/node_modules/electron/dist/electron.exe');
    await shellFile(root, 'packages/electron/main.mjs');
  } else {
    const versions = await noLinks(join(runtime.dataRoot, 'runtime', 'nnd', 'install-slots', 'versions'));
    root = await noLinks(before.root);
    if (key(dirname(root)) !== key(versions) || key(before.root) !== key(root)) throw new Error('native-package-slot-mismatch');
    const verified = await verifyPrebuiltPayload(root);
    assertSlotPath(root, versions, before, verified);
    payloadSha256 = verified.sha256;
    executable = join(root, 'packages', 'electron', 'node_modules', 'electron', 'dist', 'electron.exe');
  }
  const after = await nativeStatus(runtime);
  if (key(after.root) !== key(root) || after.version !== before.version) throw new Error('native-package-changed');
  const currentSelection = readNativeServiceSelection({ args: [], selectionFile });
  const currentRuntime = readSelectedNativeRuntime(currentSelection.installRoot);
  if (key(currentSelection.installRoot) !== key(selection.installRoot)
    || currentSelection.installation_id !== selection.installation_id || currentSelection.data_id !== selection.data_id
    || ['root', 'dataRoot', 'node', 'cli', 'version', 'installation_id', 'data_id'].some(field =>
      key(currentRuntime[field]) !== key(runtime[field]))) throw new Error('native-selection-identity-changed');
  return Object.freeze({ root, executable,
    nnaInstallRoot: runtime.root, installationId: runtime.installation_id, dataId: runtime.data_id,
    version: before.version, payloadSha256 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: resolve-active-nnd-package.mjs ABSOLUTE_SELECTION_FILE');
  const result = await resolveActiveNndPackage(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
