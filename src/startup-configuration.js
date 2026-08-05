// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfiguration } from './configuration-sources.js';
import { loadStartupManifestDocument } from './onboarding.js';
import { workspaceIsTrusted } from './workspace-trust.js';
import { ContractError } from './ids.js';

const BUNDLED_SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'skills');

export async function loadEffectiveStartupConfiguration(options) {
  const root = resolve(options.workspaceRoot ?? process.cwd());
  const user = await loadStartupManifestDocument(options);
  const sources = [
    { name: 'user', manifest: user },
    { name: 'workspace', manifest: { workspace_root: root } },
  ];
  const projectPath = join(root, '.nna', 'settings.json');
  const trusted = await workspaceIsTrusted(options.paths.trustedWorkspaces, root);
  const project = trusted ? await readOptionalManifest(projectPath) : null;
  if (project) {
    if (project.workspace_root && resolve(project.workspace_root) !== root) {
      throw new ContractError('project_scope_mismatch', 'project configuration workspace_root does not match its containing workspace');
    }
    sources.push({ name: 'project', manifest: { ...project, workspace_root: root } });
  }
  if (options.explicitPath) sources.push({ name: 'explicit', manifest: await readManifest(options.explicitPath) });
  const resolved = resolveConfiguration(sources, { securityAudit: options.securityAudit });
  return Object.freeze({ ...resolved, project: Object.freeze({
    path: projectPath, hookRoot: join(root, '.nna', 'hooks'), skillRoot: join(root, '.nna', 'skills'), present: project !== null, trusted,
  }) });
}

export function runtimeHookRoots(paths, project) {
  return Object.freeze([
    Object.freeze({ scope: 'user', path: paths.hooks }),
    ...(project?.trusted ? [Object.freeze({ scope: 'project', path: project.hookRoot })] : []),
  ]);
}

export function runtimeSkillRoots(paths, project) {
  return Object.freeze([
    Object.freeze({ scope: 'bundled', path: BUNDLED_SKILL_ROOT }),
    ...(typeof paths.skills === 'string' ? [Object.freeze({ scope: 'user', path: paths.skills })] : []),
    ...(project?.trusted ? [Object.freeze({ scope: 'project', path: project.skillRoot })] : []),
  ]);
}

async function readOptionalManifest(path) {
  try { return await readManifest(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readManifest(path) {
  const bytes = await readFile(path);
  if (bytes.length > 1_048_576) throw new ContractError('manifest_too_large', 'configuration file exceeds bound');
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch {
    throw new ContractError('manifest_invalid', 'configuration file is not valid UTF-8 JSON');
  }
}
