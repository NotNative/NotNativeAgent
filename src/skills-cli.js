// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { SkillRegistry } from './skill-registry.js';
import { runtimeSkillRoots } from './startup-configuration.js';
import { workspaceIsTrusted } from './experience/trust.js';

export async function runSkillsCommand(args, paths, output, workspaceRoot = process.cwd()) {
  const action = args.find((item) => !item.startsWith('-')) ?? 'list';
  if (action !== 'list') throw Object.assign(new Error('invalid skills command'), { code: 'invalid_skills_command' });
  const root = resolve(workspaceRoot);
  const trusted = await workspaceIsTrusted(paths.trustedWorkspaces, root);
  const project = { trusted, skillRoot: resolve(root, '.nna', 'skills') };
  const registry = new SkillRegistry({ roots: runtimeSkillRoots(paths, project) });
  await registry.initialize();
  const catalog = registry.catalog();
  if (args.includes('--json')) output.write(`${JSON.stringify({ version: 1, skills: catalog }, null, 2)}\n`);
  else if (catalog.length === 0) output.write('No skills are registered.\n');
  else output.write(`${catalog.map((item) => `${item.id}\t${item.invocation}\t${item.description}`).join('\n')}\n`);
  return catalog;
}
