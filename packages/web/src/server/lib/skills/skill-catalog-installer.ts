// SPDX-License-Identifier: Apache-2.0
/** Bounded sparse installer for selected catalog skills. */
import { execFile } from 'node:child_process';
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { directAbsolute, scanLocalSkills, type DiscoveredSkill } from './skill-scan.ts';
import { gitCloneArguments, resolveGitIdentityProfile } from './git-identity.ts';

const CLONE_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const OWNER_REPOSITORY = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\/[a-z0-9._-]{1,199}(?:\.git)?$/iu;
const execute = promisify(execFile);

export interface SkillInstallRequest {
  source: string;
  subpath: string | null;
  selectedNames: string[];
  overwriteNames: string[];
  gitIdentityId?: string | null;
}

interface ClonedRepository { scratch: string; repository: string; }

async function cloneRepository(cloneUrl: string, gitArguments: string[]): Promise<ClonedRepository> {
  const scratch = mkdtempSync(join(tmpdir(), 'nnd-skill-install-'));
  const repository = join(scratch, 'repository');
  const currentEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  try {
    try {
      await execute('git', [...gitArguments, 'clone', '--depth', '1', '--filter=blob:none',
        '--no-checkout', '--', cloneUrl, repository], {
        timeout: CLONE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: currentEnv,
      });
    } catch (filteredError) {
      rmSync(repository, { recursive: true, force: true });
      try {
        await execute('git', [...gitArguments, 'clone', '--depth', '1', '--no-checkout', '--',
          cloneUrl, repository], {
          timeout: CLONE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: currentEnv,
        });
      } catch { throw diagnostic(filteredError); }
    }
    return { scratch, repository };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

async function selectedRepositoryPaths(repository: string, request: SkillInstallRequest): Promise<string[]> {
  const listed = await execute('git', ['-C', repository, 'ls-tree', '-r', '--name-only', 'HEAD'], {
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return listed.stdout.split(/\r?\n/u).filter((path) => isSafeRepositoryPath(path))
    .filter((path) => request.selectedNames.includes(skillNameOf(path))
      && (request.subpath === null || path.startsWith(`${request.subpath}/`)));
}

async function selectedCheckout(repository: string, paths: string[]): Promise<void> {
  const directories = [...new Set(paths.map((path) => path.split('/').slice(0, -1).join('/')))];
  try {
    await execute('git', ['-C', repository, 'sparse-checkout', 'init', '--cone'], {
      timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    await execute('git', ['-C', repository, 'sparse-checkout', 'set', '--cone', ...directories], {
      timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    await execute('git', ['-C', repository, 'checkout', 'HEAD'], {
      timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    try {
      await execute('git', ['-C', repository, 'checkout', 'HEAD'], {
        timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch { throw new SkillInstallError('invalidSource', 'Git checkout failed'); }
  }
}

export interface InstalledSkill {
  skillName: string;
  scope: 'user' | 'project';
  source: 'opencode' | 'agents';
}

export class SkillInstallError extends Error {
  kind: 'authRequired' | 'networkError' | 'invalidSource' | 'unknown';

  constructor(kind: SkillInstallError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

function absoluteLike(value: string): boolean {
  return isAbsolute(value) || /^([A-Za-z]:)[\\/]/u.test(value);
}

function repositoryUrl(source: string): string | null {
  if (absoluteLike(source)) return source;
  if (OWNER_REPOSITORY.test(source)) return `https://github.com/${source}`;
  try {
    const url = new URL(source);
    if (url.protocol === 'file:' && url.username.length === 0 && url.password.length === 0) return source;
    if (url.protocol === 'ssh:' && url.password.length === 0
      && url.hostname.length > 0 && url.pathname.length > 1) return url.toString();
    if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0
      || url.search !== '' || url.hash !== '' || url.hostname.length === 0 || url.pathname.length <= 1) return null;
    return url.toString();
  } catch {
    return absoluteLike(source) ? source : null;
  }
}

function diagnostic(error: unknown): SkillInstallError {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('authentication failed') || message.includes('could not read username')
    || message.includes('permission denied')) {
    return new SkillInstallError('authRequired', 'Git authentication is required');
  }
  return new SkillInstallError('networkError', 'Git source is unreachable');
}

function installRoot(scope: 'user' | 'project', targetSource: 'opencode' | 'agents',
  checkout: string | null): string {
  if (scope === 'project') {
    return join(checkout!, targetSource === 'agents' ? '.agents' : '.opencode', 'skills');
  }
  return targetSource === 'agents'
    ? join(homedir(), '.agents', 'skills')
    : join(directAbsolute(process.env.OPENCODE_CONFIG_DIR) ?? join(homedir(), '.opencode'), 'skills');
}

function existingSkill(scope: 'user' | 'project', targetSource: 'opencode' | 'agents',
  checkout: string | null, skillName: string): DiscoveredSkill | undefined {
  const root = installRoot(scope, targetSource, checkout);
  const path = join(root, skillName, 'SKILL.md');
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile()) return undefined;
  const text = stats.size > MAX_FILE_BYTES
    ? '<oversized skill file>'
    : readFileSync(path, 'utf8');
  return { name: skillName, path, scope, source: targetSource, description: text, renamable: false, sources: { md: { path, exists: true } } };
}

function catalogConflictDirectory(scope: 'user' | 'project', checkout: string | null): string {
  return scope === 'user' ? homedir() : checkout!;
}

export function catalogConflicts(request: {
  scope: 'user' | 'project';
  targetSource: 'opencode' | 'agents';
  checkout: string | null;
  selectedNames: string[];
}): Array<{ skillName: string; path: string; scope: 'user' | 'project';
  source: 'opencode' | 'claude' | 'agents' }> {
  const conflictDirectory = catalogConflictDirectory(request.scope, request.checkout);
  const discovered = new Map(scanLocalSkills(conflictDirectory)
    .filter((skill) => request.selectedNames.includes(skill.name))
    .map((skill) => [skill.name, skill] as const));
  const result: Array<{ skillName: string; path: string; scope: 'user' | 'project';
    source: 'opencode' | 'claude' | 'agents' }> = [];
  for (const skillName of request.selectedNames) {
    const skill = existingSkill(request.scope, request.targetSource, request.checkout, skillName)
      ?? discovered.get(skillName);
    if (skill) result.push({ skillName, path: skill.path, scope: skill.scope, source: skill.source });
  }
  return result;
}

function isSafeRepositoryPath(value: string): boolean {
  if (value === '' || value.includes('\\') || !value.endsWith('/SKILL.md')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function skillNameOf(value: string): string {
  return value.split('/').at(-2) ?? '';
}

function usableSubpath(value: string): boolean {
  if (absoluteLike(value) || value.includes('\\') || value.length > 256) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && !value.split('/').some((segment) => /^([A-Za-z]:)/u.test(segment));
}

function validFrontmatter(source: string, skillName: string): boolean {
  const opening = /^(?:\ufeff)?---\r?\n/u.exec(source);
  if (!opening) return false;
  const closing = /\r?\n---(?:\r?\n|$)/u.exec(source.slice(opening[0].length));
  if (!closing) return false;
  const metadata = source.slice(opening[0].length, opening[0].length + closing.index);
  for (const line of metadata.split(/\r?\n/u)) {
    const nameMatch = /^name:\s*(.+)$/iu.exec(line);
    if (nameMatch && nameMatch[1]!.trim() !== skillName) return false;
  }
  return true;
}

function skillBytes(path: string, total: { count: number }): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) throw new SkillInstallError('invalidSource', 'selected skill is incomplete');
  if (stats.isSymbolicLink() || !stats.isFile() && !stats.isDirectory()) {
    throw new SkillInstallError('invalidSource', 'selected skill contains an unsafe path');
  }
  if (stats.isFile()) {
    if (stats.size > MAX_FILE_BYTES) throw new SkillInstallError('invalidSource', 'selected skill file is oversized');
    total.count += stats.size;
    if (total.count > MAX_SKILL_BYTES) throw new SkillInstallError('invalidSource', 'selected skill is oversized');
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    skillBytes(join(path, entry.name), total);
  }
}

function copyTree(source: string, target: string, copied: Set<string>, total: { count: number }): void {
  const stats = lstatSync(source, { throwIfNoEntry: false });
  if (!stats) throw new SkillInstallError('invalidSource', 'selected skill is incomplete');
  if (stats.isSymbolicLink() || !stats.isFile() && !stats.isDirectory()) {
    throw new SkillInstallError('invalidSource', 'selected skill contains an unsafe path');
  }
  if (copied.has(source)) return;
  copied.add(source);
  if (stats.isFile()) {
    if (stats.size > MAX_FILE_BYTES) throw new SkillInstallError('invalidSource', 'selected skill file is oversized');
    total.count += stats.size;
    if (total.count > MAX_SKILL_BYTES) throw new SkillInstallError('invalidSource', 'selected skill is oversized');
    copyFileSync(source, target);
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    copyTree(join(source, entry.name), join(target, entry.name), copied, total);
  }
}

function isInside(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return !difference.startsWith('..') && !isAbsolute(difference);
}

function projectSkillRoot(target: { scope: 'user' | 'project'; checkout: string | null },
  targetRoot: string): string {
  if (target.scope !== 'project' || target.checkout === null) return targetRoot;
  const checkout = realpathSync(target.checkout);
  const missing: string[] = [];
  let current = targetRoot;
  while (lstatSync(current, { throwIfNoEntry: false }) === undefined) {
    missing.push(current.split(/[\\/]/u).at(-1) ?? '');
    current = dirname(current);
  }
  try {
    const resolved = realpathSync(current);
    if (!isInside(checkout, resolved)) {
      throw new SkillInstallError('invalidSource', 'project skill target escaped its checkout');
    }
    return join(resolved, ...missing.reverse());
  } catch (error) {
    if (error instanceof SkillInstallError) throw error;
    throw new SkillInstallError('invalidSource', 'project skill target escaped its checkout');
  }
}

function requiredIdentity(identityId: string | null | undefined) {
  if (identityId === undefined || identityId === null || identityId === '') return null;
  const profile = resolveGitIdentityProfile(identityId);
  if (profile === null) throw new SkillInstallError('invalidSource', 'unknown Git identity');
  return profile;
}

export async function installSelectedSkills(request: SkillInstallRequest,
  target: { scope: 'user' | 'project'; targetSource: 'opencode' | 'agents'; checkout: string | null }): Promise<InstalledSkill[]> {
  const cloneUrl = repositoryUrl(request.source);
  if (!cloneUrl) throw new SkillInstallError('invalidSource', 'invalid Git source');
  const identity = requiredIdentity(request.gitIdentityId);
  const { scratch, repository } = await cloneRepository(cloneUrl, gitCloneArguments(identity));
  try {
    const selectedPaths = await selectedRepositoryPaths(repository, request);
    const selectedNames = selectedPaths.map(skillNameOf);
    const missing = request.selectedNames.filter((name) => !selectedNames.includes(name));
    if (missing.length > 0) {
      throw new SkillInstallError('invalidSource', `skills were not found: ${missing.join(', ')}`);
    }
    await selectedCheckout(repository, selectedPaths);
    const repositoryRoot = realpathSync(repository);
    const targetRoot = projectSkillRoot(target, installRoot(target.scope, target.targetSource, target.checkout));
    mkdirSync(targetRoot, { recursive: true });
    const installed: InstalledSkill[] = [];
    for (const path of selectedPaths) {
      const skillName = skillNameOf(path);
      const sourceSkill = realpathSync(join(repository, ...path.split('/')));
      const sourceSkillRoot = realpathSync(join(repository, ...path.split('/').slice(0, -1)));
      if (relative(repositoryRoot, sourceSkill).startsWith('..') || isAbsolute(relative(repositoryRoot, sourceSkill))
        || relative(repositoryRoot, sourceSkillRoot).startsWith('..')) {
        throw new SkillInstallError('invalidSource', 'selected skill escaped the repository');
      }
      const skillStats = lstatSync(sourceSkill, { throwIfNoEntry: false });
      if (!skillStats?.isFile() || skillStats.size > MAX_FILE_BYTES) {
        throw new SkillInstallError('invalidSource', `skill is not installable: ${skillName}`);
      }
      const frontmatter = readFileSync(sourceSkill, 'utf8');
      if (!validFrontmatter(frontmatter, skillName)) {
        throw new SkillInstallError('invalidSource', `skill is not installable: ${skillName}`);
      }
      const total = { count: 0 };
      skillBytes(sourceSkillRoot, total);
      const skillTarget = join(targetRoot, skillName);
      const existingTarget = lstatSync(skillTarget, { throwIfNoEntry: false });
      if (existingTarget?.isSymbolicLink()) {
        throw new SkillInstallError('invalidSource', 'skill target is not managed here');
      }
      if (existingTarget) {
        if (!request.overwriteNames.includes(skillName)) {
          throw new SkillInstallError('invalidSource', `skill conflict changed during install: ${skillName}`);
        }
        rmSync(skillTarget, { recursive: true, force: false });
      }
      copyTree(sourceSkillRoot, skillTarget, new Set(), total);
      installed.push({ skillName, scope: target.scope, source: target.targetSource });
    }
    return installed;
  } catch (error) {
    if (error instanceof SkillInstallError) throw error;
    throw diagnostic(error);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
