// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { SkillRegistry } from './skill-registry.js';
import { runtimeSkillRoots } from './startup-configuration.js';
import { workspaceIsTrusted } from './experience/trust.js';
import { ContractError } from './ids.js';

const PROJECT_CONFIG_DIRECTORY = '.nna';
const LIST_ACTION = 'list';
const JSON_FLAG = '--json';
const TSV_UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

export async function runSkillsCommand(args, paths, output, workspaceRoot = process.cwd()) {
  validateDependencies(args, paths, output);
  const positionals = args.filter((item) => !item.startsWith('-'));
  const flags = args.filter((item) => item.startsWith('-'));
  const action = positionals[0] ?? LIST_ACTION;
  if (positionals.length > 1 || action !== LIST_ACTION || flags.some((flag) => flag !== JSON_FLAG)) {
    throw new ContractError('invalid_skills_command', 'usage: nna skills [list] [--json]');
  }
  try {
    const root = resolve(workspaceRoot);
    const trusted = await workspaceIsTrusted(paths.trustedWorkspaces, root);
    const project = { trusted, skillRoot: resolve(root, PROJECT_CONFIG_DIRECTORY, 'skills') };
    const registry = new SkillRegistry({ roots: runtimeSkillRoots(paths, project) });
    await registry.initialize();
    const catalog = registry.catalog();
    if (flags.includes(JSON_FLAG)) output.write(`${JSON.stringify({ version: 1, skills: catalog }, null, 2)}\n`);
    else if (catalog.length === 0) output.write('No skills are registered.\n');
    else output.write(`${catalog.map(formatTsvSkill).join('\n')}\n`);
    return catalog;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('skills_catalog_unavailable', 'skills catalog could not be loaded', { cause: error });
  }
}

function validateDependencies(args, paths, output) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
    throw new ContractError('invalid_skills_command', 'skills arguments must be strings');
  }
  if (typeof paths?.trustedWorkspaces !== 'string' || typeof output?.write !== 'function') {
    throw new ContractError('skills_runtime_invalid', 'skills command requires valid runtime paths and output');
  }
}

function formatTsvSkill(item) {
  return [item.id, item.invocation, item.description]
    .map((value) => String(value ?? '').replace(TSV_UNSAFE_CONTROL_CHARACTERS, ' '))
    .join('\t');
}
