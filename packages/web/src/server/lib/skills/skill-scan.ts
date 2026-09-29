// SPDX-License-Identifier: Apache-2.0
/** Read-only harness-equivalent scan for local SKILL.md folders. */
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface DiscoveredSkill {
  name: string; path: string; scope: 'user' | 'project';
  source: 'opencode' | 'claude' | 'agents'; description: string;
  group?: string; renamable: boolean; sources: Record<string, unknown>;
}

const SCAN_LIMIT = 200;
const MAX_CONFIG_FILE_BYTES = 1_048_576;

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

function scanDirectory(path: string, scope: 'user' | 'project', source: 'claude' | 'agents' | 'opencode',
  output: DiscoveredSkill[], managed = false): void {
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
          group: skillGroup(child),
          renamable: managed,
          sources: { md: { path: child, exists: true } },
        });
      } catch { /* unreadable skill files are omitted from the display list */ }
    } else if (entry.isDirectory()) scanDirectory(child, scope, source, output, managed);
  }
}

function visible(source: DiscoveredSkill['source'], flags: ReturnType<typeof externalSkillFlags>): boolean {
  if (flags.allDisabled) return source === 'opencode';
  return !flags.claudeDisabled || source !== 'claude';
}

function worktreeRootOf(directory: string): string | null {
  try {
    const root = execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 2_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = root.trim();
    return trimmed.length > 0 && isAbsolute(trimmed) ? realpathSync(trimmed) : null;
  } catch { return null; }
}

function insideWorktree(root: string, directory: string): boolean {
  return relative(root, directory) === '' || !relative(root, directory).startsWith('..')
    && !isAbsolute(relative(root, directory));
}

export function directAbsolute(candidate: string | undefined): string | null {
  if (!candidate || candidate.trim() === '' || !isAbsolute(candidate)) return null;
  return resolve(candidate) === candidate ? candidate : null;
}

function readConfigSkillPaths(path: string): string[] {
  let parsed;
  try {
    const metadata = statSync(path, { throwIfNoEntry: false });
    if (!metadata?.isFile() || metadata.size > MAX_CONFIG_FILE_BYTES) return [];
    const descriptor = openSync(path, 'r');
    try {
      const file = fstatSync(descriptor);
      if (!file.isFile() || file.size > MAX_CONFIG_FILE_BYTES) return [];
      const bytes = Buffer.allocUnsafe(file.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== bytes.length) throw new Error('config changed while reading');
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } finally { closeSync(descriptor); }
  }
  catch { return []; }
  const raw = (parsed as { skills?: { paths?: unknown } } | undefined)?.skills?.paths;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): string[] => {
    if (typeof entry !== 'string' || entry.trim() === '') return [];
    const expanded = entry.startsWith('~/') || entry.startsWith('~\\')
      ? join(homedir(), entry.slice(2)) : entry;
    return directAbsolute(expanded) === null ? [] : [expanded];
  });
}

function projectSkillRoots(directory: string): string[] {
  let requested;
  try { requested = realpathSync(directory); } catch { return []; }
  if (!isAbsolute(requested)) return [];
  const root = worktreeRootOf(requested);
  if (!root || !insideWorktree(root, requested)) return [requested];
  const roots: string[] = [];
  let current = requested;
  while (true) {
    roots.unshift(current);
    if (relative(root, current) === '') break;
    const parent = dirname(current);
    if (parent === current || !insideWorktree(root, parent)) return [requested];
    current = parent;
  }
  return roots;
}

export function scanLocalSkills(directory: string): DiscoveredSkill[] {
  if (!isAbsolute(directory) || directory.trim() === '') {
    throw new Error('project checkout directory is required');
  }
  const output: DiscoveredSkill[] = [];
  const flags = externalSkillFlags();
  const xdgConfigHomeRoot = directAbsolute(process.env.XDG_CONFIG_HOME);
  const openCodeConfigRoots = [
    directAbsolute(process.env.OPENCODE_CONFIG_DIR),
    directAbsolute(join(homedir(), '.opencode')),
    directAbsolute(join(homedir(), '.config', 'opencode')),
    directAbsolute(xdgConfigHomeRoot ? join(xdgConfigHomeRoot, 'opencode') : undefined),
  ].filter((root): root is string => root !== null);
  const uniqueOpenCodeConfigRoots = [...new Set(openCodeConfigRoots)];
  const projectRoots = projectSkillRoots(directory);
  const configSkillRoots = [
    process.env.OPENCODE_CONFIG,
    ...uniqueOpenCodeConfigRoots.map((root) => join(root, 'opencode.json')),
    ...projectRoots.map((root) => join(root, '.opencode', 'opencode.json')),
  ].flatMap((path): string[] => typeof path === 'string' ? readConfigSkillPaths(path) : []);
  if (visible('claude', flags)) {
    scanDirectory(join(homedir(), '.claude', 'skills'), 'user', 'claude', output);
  }
  if (visible('agents', flags)) {
    scanDirectory(join(homedir(), '.agents', 'skills'), 'user', 'agents', output);
  }
  for (const root of uniqueOpenCodeConfigRoots) {
    scanDirectory(join(root, 'skill'), 'user', 'opencode', output, true);
    scanDirectory(join(root, 'skills'), 'user', 'opencode', output, true);
  }
  const cacheHome = process.env.XDG_CACHE_HOME;
  const cacheHomeRoot = directAbsolute(cacheHome);
  const cacheRoots = [
    cacheHomeRoot ? join(cacheHomeRoot, 'opencode', 'skills') : null,
    join(homedir(), '.cache', 'opencode', 'skills'),
    join(homedir(), 'Library', 'Caches', 'opencode', 'skills'),
  ].filter((root): root is string => root !== null && isAbsolute(root));
  for (const root of new Set(cacheRoots)) {
    scanDirectory(root, 'user', 'opencode', output);
  }
  for (const root of new Set(configSkillRoots)) {
    scanDirectory(root, 'project', 'opencode', output);
  }
  for (const root of projectRoots) {
    if (visible('claude', flags)) {
      scanDirectory(join(root, '.claude', 'skills'), 'project', 'claude', output);
    }
    if (visible('agents', flags)) {
      scanDirectory(join(root, '.agents', 'skills'), 'project', 'agents', output);
    }
    for (const layout of ['skill', 'skills'] as const) {
      scanDirectory(join(root, '.opencode', layout), 'project', 'opencode', output, true);
    }
  }
  const unique = new Map<string, DiscoveredSkill>();
  for (const skill of output) unique.set(skill.name, skill);
  return [...unique.values()];
}
