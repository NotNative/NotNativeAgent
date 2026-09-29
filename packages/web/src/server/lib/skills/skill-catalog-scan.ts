// SPDX-License-Identifier: Apache-2.0
/** Bounded one-shot Git source scan for catalog SKILL.md items. */
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { scanLocalSkills } from './skill-scan.ts';

const MAX_ITEMS = 200;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const CLONE_TIMEOUT_MS = 30_000;
const OWNER_REPOSITORY = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\/[a-z0-9._-]{1,199}(?:\.git)?$/iu;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/u;
const execute = promisify(execFile);

export interface CatalogScanRequest {
  source: string;
  subpath: string | null;
  directory?: string;
  gitIdentityId?: string | null;
}

export interface CatalogScanItem {
  repoSource: string;
  repoSubpath: string | null;
  skillDir: string;
  skillName: string;
  frontmatterName: string;
  description: string;
  installable: boolean;
  warnings: string[];
  installed: { isInstalled: boolean; scope: 'user' | 'project' | null; source: string | null };
}

export class CatalogScanError extends Error {
  kind: 'authRequired' | 'networkError' | 'invalidSource' | 'unknown';

  constructor(kind: CatalogScanError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !/\p{Control}/u.test(value);
}

function usableSubpath(value: string): boolean {
  if (/^([A-Za-z]:)?[\\/]/u.test(value) || value.includes('\\') || value.length > 256) return false;
  if (!value) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && !value.split('/').some((segment) => /^([A-Za-z]:)/u.test(segment));
}

function repositoryUrl(source: string): string | null {
  if (absoluteLike(source)) return source;
  if (OWNER_REPOSITORY.test(source)) return `https://github.com/${source}`;
  try {
    const url = new URL(source);
    if (url.protocol === 'file:' && url.username.length === 0 && url.password.length === 0) return source;
    if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0
      || url.search !== '' || url.hash !== '' || url.hostname.length === 0 || url.pathname.length <= 1) return null;
    return url.toString();
  } catch {
    return absoluteLike(source) ? source : null;
  }
}

function absoluteLike(value: string): boolean {
  return isAbsolute(value) || /^([A-Za-z]:)[\\/]/u.test(value);
}

function frontmatter(source: string, fallbackName: string): { name: string; description: string; opened: boolean } {
  const opening = /^(?:\ufeff)?---\r?\n/.exec(source);
  if (!opening) return { name: fallbackName, description: '', opened: false };
  const closing = /\r?\n---(?:\r?\n|$)/.exec(source.slice(opening[0].length));
  if (!closing) return { name: fallbackName, description: '', opened: false };
  const metadata = source.slice(opening[0].length, opening[0].length + closing.index);
  let name = fallbackName;
  let description = '';
  for (const line of metadata.split(/\r?\n/u)) {
    const nameMatch = /^name:\s*(.+)$/iu.exec(line);
    const descriptionMatch = /^description:\s*(.+)$/iu.exec(line);
    if (nameMatch) name = nameMatch[1]!.trim().slice(0, 120);
    if (descriptionMatch) description = descriptionMatch[1]!.trim().slice(0, 500);
  }
  return { name, description, opened: true };
}

function installedStateOf(itemName: string, installedSkills: ReturnType<typeof scanLocalSkills>):
  CatalogScanItem['installed'] {
  const installed = installedSkills.find((skill) => skill.name === itemName);
  if (!installed) return { isInstalled: false, scope: null, source: null };
  return { isInstalled: true, scope: installed.scope, source: installed.source };
}

function scanSkills(root: string, source: string, subpath: string | null,
  directory: string | undefined, repositoryRoot: string): CatalogScanItem[] {
  const output: CatalogScanItem[] = [];
  let installedSkills: ReturnType<typeof scanLocalSkills> = [];
  if (directory) {
    try { installedSkills = scanLocalSkills(directory); } catch { installedSkills = []; }
  }
  const walk = (directoryPath: string): void => {
    const entries = readdirSync(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= MAX_ITEMS) return;
      const child = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        const stat = statSync(child, { throwIfNoEntry: false });
        if (stat?.isFile() && stat.size <= MAX_SKILL_FILE_BYTES) {
          const normalized = relative(repositoryRoot, child).replaceAll('\\', '/').split('/');
          const declaredName = normalized.at(-2) ?? 'unnamed';
          const parsed = frontmatter(readFileSync(child, 'utf8'), declaredName);
          const warnings: string[] = [];
          if (!parsed.opened) warnings.push('frontmatter:missing');
          if (!SKILL_NAME.test(declaredName)) warnings.push('name:invalid');
          output.push({
            repoSource: source,
            repoSubpath: subpath,
            skillDir: normalized.slice(0, -1).join('/'),
            skillName: declaredName,
            frontmatterName: parsed.name,
            description: parsed.description,
            installable: SKILL_NAME.test(declaredName) && parsed.opened,
            warnings,
            installed: installedStateOf(declaredName, installedSkills),
          });
        }
      }
    }
  };
  walk(root);
  return output;
}

function diagnostic(error: unknown): CatalogScanError {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('authentication failed') || message.includes('could not read username')
    || message.includes('permission denied')) {
    return new CatalogScanError('authRequired', 'Git authentication is required');
  }
  if (message.includes('could not resolve host') || message.includes('could not connect')
    || message.includes('failed to connect') || message.includes('repository') && message.includes('does not exist')
    || message.includes('remote') && message.includes('not found')) {
    return new CatalogScanError('networkError', 'Git source is unreachable');
  }
  return new CatalogScanError('networkError', 'Git source is unreachable');
}

export async function scanCatalogSource(request: CatalogScanRequest): Promise<CatalogScanItem[]> {
  if (request.gitIdentityId !== undefined && request.gitIdentityId !== null && request.gitIdentityId !== '') {
    throw new CatalogScanError('invalidSource', 'Git identity scanning is not yet configured');
  }
  if (!isText(request.source, 512) || /\s/u.test(request.source) || request.source.startsWith('-')) {
    throw new CatalogScanError('invalidSource', 'invalid Git source');
  }
  const cloneUrl = repositoryUrl(request.source);
  if (!cloneUrl) throw new CatalogScanError('invalidSource', 'invalid Git source');
  const subpath = request.subpath;
  if (subpath !== null && subpath !== undefined
    && (!isText(subpath, 256) || !usableSubpath(subpath))) {
    throw new CatalogScanError('invalidSource', 'invalid Git subpath');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'nnd-skill-catalog-'));
  const repository = join(scratch, 'repository');
  try {
    try {
      await execute('git', ['clone', '--depth', '1', '--filter=blob:none', '--', cloneUrl, repository], {
        timeout: CLONE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch {
      rmSync(repository, { recursive: true, force: true });
      try {
        await execute('git', ['clone', '--depth', '1', '--', cloneUrl, repository], {
          timeout: CLONE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
      } catch (fallbackError) {
        throw diagnostic(fallbackError);
      }
    }
    const repositoryRoot = realpathSync(repository);
    let scanRoot: string;
    let contained: string;
    try {
      scanRoot = realpathSync(join(repository, subpath ?? '.'));
      contained = relative(repositoryRoot, scanRoot);
    } catch {
      throw new CatalogScanError('invalidSource', 'invalid Git subpath');
    }
    if (contained === '' || contained.startsWith('..') || isAbsolute(contained)) {
      throw new CatalogScanError('invalidSource', 'invalid Git subpath');
    }
    const stat = statSync(scanRoot, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return [];
    return scanSkills(scanRoot, request.source, subpath ?? null, request.directory, repositoryRoot);
  } catch (error) {
    if (error instanceof CatalogScanError) throw error;
    throw diagnostic(error);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
