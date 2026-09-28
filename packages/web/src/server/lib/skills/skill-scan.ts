// SPDX-License-Identifier: Apache-2.0
/** Read-only harness-equivalent scan for local SKILL.md folders. */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

export interface DiscoveredSkill {
  name: string; path: string; scope: 'user' | 'project';
  source: 'opencode' | 'claude' | 'agents'; description: string;
  group?: string; renamable: boolean; sources: Record<string, unknown>;
}

const SCAN_LIMIT = 200;

function disableFlag(value: string | undefined): boolean {
  if (value === '' || value === undefined || value === null) return false;
  return !['0', 'false'].includes(value.trim().toLowerCase());
}

export function externalSkillFlags(): { claudeDisabled: boolean; allDisabled: boolean } {
  return {
    claudeDisabled: disableFlag(process.env.OPENCODE_DISABLE_CLAUDE_CODE)
      || disableFlag(process.env.OPENCODE_DISABLE_CLAUDE_SKILLS),
    allDisabled: disableFlag(process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS),
  };
}

function frontmatter(text: string, fallbackName: string): { name: string; description: string } {
  const opening = /^(?:\ufeff)?---\r?\n/.exec(text);
  if (!opening) return { name: fallbackName, description: '' };
  const closing = /\r?\n---(?:\r?\n|$)/.exec(text.slice(opening[0].length));
  if (!closing) return { name: fallbackName, description: '' };
  const metadata = text.slice(opening[0].length, opening[0].length + closing.index);
  let name = fallbackName;
  let description = '';
  for (const line of metadata.split(/\r?\n/u)) {
    const nameMatch = /^name:\s*(.+)$/iu.exec(line);
    const descriptionMatch = /^description:\s*(.+)$/iu.exec(line);
    if (nameMatch) name = nameMatch[1]!.trim().slice(0, 120);
    if (descriptionMatch) description = descriptionMatch[1]!.trim().slice(0, 500);
  }
  return { name, description };
}

function displayRoot(directory: string): { scope: 'user' | 'project'; source: 'claude' | 'agents' } {
  return {
    scope: directory.startsWith(homedir()) ? 'user' : 'project',
    source: directory.includes(`${sep}.agents${sep}`) ? 'agents' : 'claude',
  };
}

function skillName(path: string): string {
  return path.split(/[\\/]+/u).at(-2) ?? 'unnamed';
}

function skillGroup(path: string): string | undefined {
  const parts = path.split(/[\\/]+/u);
  const marker = parts.lastIndexOf('skills');
  return marker >= 0 && parts.length - marker >= 3 ? parts[marker + 1] : undefined;
}

function scanDirectory(path: string, scope: 'user' | 'project', source: 'claude' | 'agents',
  output: DiscoveredSkill[]): void {
  if (output.length >= SCAN_LIMIT) return;
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); }
  catch { return; }
  for (let index = 0; index < entries.length && output.length < SCAN_LIMIT; index += 1) {
    const entry = entries[index]!;
    const child = join(path, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') {
      try {
        const parsed = frontmatter(readFileSync(child, 'utf8'), skillName(child));
        output.push({
          name: parsed.name, path: child, scope, source, description: parsed.description,
          group: skillGroup(child), renamable: false,
          sources: { md: { path: child, exists: true } },
        });
      } catch { /* unreadable skill files are omitted from the display list */ }
    } else if (entry.isDirectory()) scanDirectory(child, scope, source, output);
  }
}

function visible(source: DiscoveredSkill['source'], flags: ReturnType<typeof externalSkillFlags>): boolean {
  if (flags.allDisabled) return source === 'opencode';
  return !flags.claudeDisabled || source !== 'claude';
}

export function scanLocalSkills(directory: string): DiscoveredSkill[] {
  if (!isAbsolute(directory) || directory.trim() === '') {
    throw new Error('project checkout directory is required');
  }
  const output: DiscoveredSkill[] = [];
  const flags = externalSkillFlags();
  if (visible('claude', flags)) {
    scanDirectory(join(homedir(), '.claude', 'skills'), 'user', 'claude', output);
  }
  if (visible('agents', flags)) {
    scanDirectory(join(homedir(), '.agents', 'skills'), 'user', 'agents', output);
  }
  if (visible('claude', flags)) {
    scanDirectory(join(directory, '.claude', 'skills'), 'project', 'claude', output);
  }
  if (visible('agents', flags)) {
    scanDirectory(join(directory, '.agents', 'skills'), 'project', 'agents', output);
  }
  const unique = new Map<string, DiscoveredSkill>();
  for (const skill of output) unique.set(skill.name, skill);
  return [...unique.values()];
}
