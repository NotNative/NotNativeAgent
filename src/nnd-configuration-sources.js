// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { resolveConfiguration } from './configuration-sources.js';
import { workspaceIsTrusted } from './experience/trust.js';

const MAX_MANIFEST_BYTES = 1_048_576;
export const NND_CONFIGURATION_OPTIONS = Object.freeze({
  missionPrincipal: 'authenticated-nnd-operator', principal: 'authenticated-nnd-operator',
  hostOrigin: 'nnd-integration', hostIdentity: 'nnd-integration',
});

export async function readNndConfigurationSources(paths, { signal } = {}) {
  const user = { name: 'user', ...await readSource(join(paths.config, 'manifest.json'), signal) };
  const root = resolveNndWorkspaceRoot(user.manifest.workspace_root);
  const sources = [user, { name: 'workspace', manifest: { workspace_root: root } }];
  signal?.throwIfAborted();
  const trusted = typeof paths.trustedWorkspaces === 'string'
    ? await workspaceIsTrusted(paths.trustedWorkspaces, root) : false;
  signal?.throwIfAborted();
  const projectPath = join(root, '.nna', 'settings.json');
  const project = trusted ? await readOptionalSource(projectPath, signal) : null;
  if (project) {
    assertNndProjectWorkspace(project.manifest, root);
    sources.push({ name: 'project', ...project });
  }
  const resolved = resolveConfiguration(sources, { manifestOptions: NND_CONFIGURATION_OPTIONS });
  // Security: a project overlay cannot select another background workspace through null or relative values.
  if (!sameWorkspace(resolved.config.workspaceRoot, root)) throw invalid();
  signal?.throwIfAborted();
  const resolutionRevision = digest(JSON.stringify({ sources: sources.map(({ name, revision, manifest }) =>
    ({ name, revision: revision ?? digest(JSON.stringify(manifest)) })), trusted, projectPresent: project !== null }));
  return freezeTree({ ...resolved, persistedSource: user, sourceSnapshots: sources, resolutionRevision,
    project: { path: projectPath, hookRoot: join(root, '.nna', 'hooks'), skillRoot: join(root, '.nna', 'skills'),
      present: project !== null, trusted } });
}

export function resolveNndWorkspaceRoot(value) {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  return resolve(value);
}

export function assertNndProjectWorkspace(manifest, root) {
  if (manifest && Object.hasOwn(manifest, 'workspace_root') && !sameWorkspace(manifest.workspace_root, root)) {
    throw new ContractError('project_scope_mismatch', 'project configuration workspace_root does not match its containing workspace');
  }
}

function sameWorkspace(value, expected) {
  if (typeof value !== 'string' || !isAbsolute(value)) return false;
  const key = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return key(value) === key(expected);
}

async function readOptionalSource(path, signal) {
  try { return await readSource(path, signal); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readSource(path, signal) {
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw invalid();
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, count, buffer.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > MAX_MANIFEST_BYTES) throw invalid();
    const bytes = buffer.subarray(0, count);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw invalid(); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalid();
    return { path, manifest, revision: digest(bytes) };
  } finally { await handle.close(); }
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function invalid() { return new ContractError('nnd_setup_configuration_invalid', 'NND requires bounded valid configuration with an explicit absolute workspace.'); }

function freezeTree(value) {
  const pending = [value], seen = new Set();
  while (pending.length) {
    if (seen.size > 10000) throw invalid();
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) if (child && typeof child === 'object') pending.push(child);
    Object.freeze(current);
  }
  return value;
}
