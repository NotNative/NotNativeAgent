// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ContractError } from './ids.js';
import { isNndVersion } from './nnd-service-contract.js';

const LIMIT = 16 * 1024;
const PROBE = 'JSON.stringify({version:process.versions.node,architecture:process.arch,platform:process.platform})';
const execute = promisify(execFile);
function fail(code, message) { throw new ContractError(code, message); }
function pathKey(path) { return process.platform === 'win32' ? path.toLowerCase() : path; }
function inside(root, target) {
  const part = relative(root, target);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
function absolutePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\u0000-\u001f]/u.test(value) && isAbsolute(value);
}
async function canonicalDirectory(value, code) {
  if (!absolutePath(value)) fail(code, 'NNA directory must be an absolute bounded path');
  try {
    const path = await realpath(value);
    if (!(await stat(path)).isDirectory()) fail(code, 'NNA directory is unavailable');
    return resolve(path);
  } catch { fail(code, 'NNA directory is unavailable'); }
}
async function canonicalFile(value, root, code) {
  if (!absolutePath(value)) fail(code, 'NNA file must be an absolute bounded path');
  try {
    const path = await realpath(value);
    if ((root && !inside(root, path)) || !(await stat(path)).isFile()) fail(code, 'NNA file is outside its package or unavailable');
    return path;
  } catch { fail(code, 'NNA file is outside its package or unavailable'); }
}
async function boundedText(path, code) {
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > LIMIT) fail(code, 'NNA metadata exceeds its bound or is not a file');
    const buffer = Buffer.alloc(LIMIT + 1);
    let count = 0;
    while (count <= LIMIT) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > LIMIT) fail(code, 'NNA metadata exceeds its bound');
    return buffer.subarray(0, count).toString('utf8');
  } catch (error) {
    if (error instanceof ContractError) throw error;
    fail(code, 'NNA metadata could not be read');
  } finally { await handle?.close(); }
}
async function jsonFile(path, code) {
  const text = await boundedText(path, code);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch { fail(code, 'NNA metadata is invalid JSON'); }
}
function validateDescriptor(value) {
  if (value.product !== 'NotNativeAgent' || !isNndVersion(value.version)
    || !absolutePath(value.install_root) || !absolutePath(value.data_root) || !absolutePath(value.node)
    || !Number.isSafeInteger(value.node_major) || value.node_major < 24 || value.node_major > 100
    || (value.incarnation_id !== undefined
      && !(typeof value.incarnation_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.incarnation_id)))) {
    fail('nnd_install_descriptor_invalid', 'NNA installation descriptor fields are invalid');
  }
}
async function installedFiles(root, descriptor) {
  const payload = await canonicalDirectory(join(root, 'installed'), 'nnd_install_payload_invalid');
  if (!inside(root, payload) || pathKey(payload) === pathKey(root)) fail('nnd_install_payload_invalid', 'NNA payload escapes its installation');
  const cli = await canonicalFile(join(payload, 'src', 'cli.js'), payload, 'nnd_install_payload_invalid');
  const metadata = await canonicalFile(join(payload, 'package.json'), payload, 'nnd_install_payload_invalid');
  const versionPath = await canonicalFile(join(payload, 'VERSION'), payload, 'nnd_install_payload_invalid');
  const packageInfo = await jsonFile(metadata, 'nnd_install_payload_invalid');
  const version = (await boundedText(versionPath, 'nnd_install_payload_invalid')).trim();
  if (packageInfo.name !== 'not-native-agent' || packageInfo.nna_version !== descriptor.version || version !== descriptor.version) {
    fail('nnd_install_version_mismatch', 'NNA descriptor and installed payload versions differ');
  }
  return cli;
}
async function probeNode(node, major) {
  let output;
  try {
    // Security: Node startup hooks from the operator environment cannot run during descriptor verification.
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]));
    output = await execute(node, ['-p', PROBE], { env, shell: false, windowsHide: true, timeout: 3000, maxBuffer: 4096 });
  } catch { fail('nnd_install_runtime_unavailable', 'Selected Node runtime could not be verified within its bounds'); }
  let runtime;
  try { runtime = JSON.parse(output.stdout); }
  catch { fail('nnd_install_runtime_invalid', 'Selected Node runtime returned invalid metadata'); }
  if (!runtime || typeof runtime.version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(runtime.version)
    || Number(runtime.version.split('.')[0]) !== major || !['x64', 'arm64'].includes(runtime.architecture)
    || runtime.platform !== process.platform || output.stderr.trim()) {
    fail('nnd_install_runtime_invalid', 'Selected Node runtime does not match the installation descriptor');
  }
  return runtime;
}
// Compatibility: identities follow canonical paths. Relocation changes identity; no installed files are written.
export async function readNndServiceIdentity(selectedInstallRoot, options = {}) {
  const root = await canonicalDirectory(selectedInstallRoot, 'nnd_install_root_invalid');
  const descriptorPath = await canonicalFile(join(root, 'install.json'), root, 'nnd_install_descriptor_unavailable');
  const descriptor = await jsonFile(descriptorPath, 'nnd_install_descriptor_invalid');
  validateDescriptor(descriptor);
  const recordedRoot = await canonicalDirectory(descriptor.install_root, 'nnd_install_root_invalid');
  if (pathKey(recordedRoot) !== pathKey(root)) fail('nnd_install_root_mismatch', 'Selected NNA installation differs from its descriptor');
  const data = await canonicalDirectory(descriptor.data_root, 'nnd_install_data_invalid');
  if (inside(root, data)) fail('nnd_install_data_invalid', 'NNA data cannot reside inside its replaceable installation');
  if (options.expectedDataRoot !== undefined) {
    const expected = await canonicalDirectory(options.expectedDataRoot, 'nnd_install_data_invalid');
    if (pathKey(expected) !== pathKey(data)) fail('nnd_install_data_mismatch', 'Selected NNA data differs from its descriptor');
  }
  const cli = await installedFiles(root, descriptor);
  const node = await canonicalFile(descriptor.node, null, 'nnd_install_runtime_unavailable');
  if (basename(node).toLowerCase() !== (process.platform === 'win32' ? 'node.exe' : 'node')) {
    fail('nnd_install_runtime_invalid', 'Installation descriptor must select a Node executable');
  }
  const runtime = await probeNode(node, descriptor.node_major);
  const digest = (path) => createHash('sha256').update(pathKey(path), 'utf8').digest('hex');
  // ADR 0070: descriptors predating the decision report null; absence is never fabricated.
  return Object.freeze({ installation_id: `nna_${digest(root)}`, data_id: `data_${digest(data)}`,
    incarnation_id: typeof descriptor.incarnation_id === 'string' ? descriptor.incarnation_id : null,
    install_root: root, data_root: data, node, cli_path: cli, version: descriptor.version,
    node_major: descriptor.node_major, platform: runtime.platform, architecture: runtime.architecture,
    runtime_version: runtime.version });
}
