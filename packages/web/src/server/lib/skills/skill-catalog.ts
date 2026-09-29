// SPDX-License-Identifier: Apache-2.0
/** Shared curated/custom skill-catalog source and developer metadata parsing. */
import { readMergedSettings } from '../settings-store.ts';
import { isAbsolute } from 'node:path';

export const SKILL_SOURCES = [
  { id: 'anthropic', label: 'Anthropic', source: 'anthropics/skills', defaultSubpath: 'skills' },
  { id: 'openai', label: 'OpenAI', source: 'openai/skills', defaultSubpath: 'skills/.curated' },
  { id: 'cursor', label: 'Cursor', source: 'cursor/plugins', defaultSubpath: 'pstack/skills' },
  { id: 'mattpocock', label: 'Matt Pocock', source: 'mattpocock/skills', defaultSubpath: null },
] as const;

export interface CustomSkillSource {
  id: string;
  label: string;
  source: string;
  subpath: string | null;
  gitIdentityId: string | null;
}

export interface RepositoryMetadata {
  stars: number | null;
  repoUpdatedAt: string | null;
}

export type SkillCatalogSource =
  | (typeof SKILL_SOURCES)[number]
  | CustomSkillSource;

const MAX_CUSTOM_SOURCES = 32;
const GITHUB_API_TIMEOUT_MS = 2_500;
const GITHUB_METADATA_TTL_MS = 5 * 60 * 1000;
const SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const OWNER_REPOSITORY = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\/[a-z0-9._-]{1,199}(?:\.git)?$/iu;
const GITHUB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const METADATA_CACHE = new Map<string, { at: number; value: RepositoryMetadata | null }>();
const METADATA_REQUESTS = new Map<string, Promise<RepositoryMetadata | null>>();

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !/\p{Control}/u.test(value);
}

function usableRepositorySource(value: string): boolean {
  if (isAbsolute(value) || /^([A-Za-z]:)[\\/]/u.test(value)) return true;
  if (!value.trim() || value.trim() !== value || value.length > 512 || value.startsWith('-')) return false;
  if (OWNER_REPOSITORY.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol === 'ssh:' && url.password.length === 0
      && url.search === '' && url.hash === ''
      && url.hostname.length > 0 && url.pathname.length > 1) return true;
    return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0
      && url.hostname.length > 0 && url.pathname.length > 1;
  } catch { return false; }
}

function usableSubpath(value: string): boolean {
  if (/^([A-Za-z]:)?[\\/]/u.test(value)) return false;
  if (value.includes('\\') || value.length > 256) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function customSkillSource(raw: unknown): CustomSkillSource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const label = record.label;
  const repositorySource = record.source;
  if (!isText(id, 64) || !SOURCE_ID.test(id)) return null;
  if (!isText(label, 120) || label.trim() === '' || label.trim() !== label) return null;
  if (!isText(repositorySource, 512)
    || /\s/u.test(repositorySource)
    || !usableRepositorySource(repositorySource)) return null;

  const rawSubpath = record.subpath;
  if (rawSubpath !== undefined && rawSubpath !== null
    && (!isText(rawSubpath, 256) || !usableSubpath(rawSubpath))) return null;
  const rawIdentity = record.gitIdentityId;
  if (rawIdentity !== undefined && rawIdentity !== null
    && (!isText(rawIdentity, 128) || !SOURCE_ID.test(rawIdentity))) return null;
  return {
    id,
    label,
    source: repositorySource,
    subpath: rawSubpath === undefined || rawSubpath === null ? null : rawSubpath,
    gitIdentityId: rawIdentity === undefined || rawIdentity === null ? null : rawIdentity,
  };
}

function readonlyCatalogSources(): Array<CustomSkillSource> {
  const configured = readMergedSettings('web').skillCatalogs;
  if (!Array.isArray(configured)) return [];
  const entries: Array<CustomSkillSource> = [];
  const reserved = new Set<string>(SKILL_SOURCES.map((source) => source.id));
  for (const raw of configured) {
    const entry = customSkillSource(raw);
    if (!entry || reserved.has(entry.id) || entries.some((existing) => existing.id === entry.id)) continue;
    entries.push(entry);
    if (entries.length === MAX_CUSTOM_SOURCES) break;
  }
  return entries;
}

function githubRepositoryOf(source: string): string | null {
  if (OWNER_REPOSITORY.test(source)) {
    const [owner, repository] = source.split('/');
    return `${owner}/${repository?.replace(/\.git$/u, '')}`;
  }
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0
      || url.search !== '' || url.hash !== '') return null;
    const pathSegments = url.pathname.replace(/^\/+/u, '').split('/');
    if (pathSegments.length !== 2) return null;
    let repository = pathSegments.map((segment) => decodeURIComponent(segment)).join('/');
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    if (repository.endsWith('.git')) repository = repository.slice(0, -4);
    return OWNER_REPOSITORY.test(repository) ? repository : null;
  } catch { return null; }
}

function trustedMetadata(stars: unknown, repoUpdatedAt: unknown): RepositoryMetadata | null {
  const safeStars = typeof stars === 'number' && Number.isSafeInteger(stars) && stars >= 0 ? stars : null;
  const repositoryUpdated = typeof repoUpdatedAt === 'string' && GITHUB_TIMESTAMP.test(repoUpdatedAt)
    && !Number.isNaN(Date.parse(repoUpdatedAt))
    ? repoUpdatedAt : null;
  return safeStars === null && repositoryUpdated === null
    ? null : { stars: safeStars, repoUpdatedAt: repositoryUpdated };
}

async function repositoryMetadata(source: string): Promise<RepositoryMetadata | null> {
  const repository = githubRepositoryOf(source);
  if (!repository) return null;
  const now = Date.now();
  const cached = METADATA_CACHE.get(repository);
  if (cached && now - cached.at < GITHUB_METADATA_TTL_MS) return cached.value;
  const running = METADATA_REQUESTS.get(repository);
  if (running) return running;
  const request = (async (): Promise<RepositoryMetadata | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}`, {
        signal: controller.signal,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'notnative-desktop' },
      });
      if (!response.ok) return null;
      const body = await response.json() as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const metadata = trustedMetadata(
        (body as { stargazers_count?: unknown }).stargazers_count,
        (body as { pushed_at?: unknown }).pushed_at,
      );
      METADATA_CACHE.set(repository, { at: now, value: metadata ?? null });
      return metadata;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      METADATA_REQUESTS.delete(repository);
    }
  })();
  METADATA_REQUESTS.set(repository, request);
  return request;
}

async function catalogMetadata(sources: readonly SkillCatalogSource[]): Promise<Array<RepositoryMetadata>> {
  const output = new Array<RepositoryMetadata>(sources.length);
  for (let offset = 0; offset < sources.length; offset += 2) {
    const sourceslice = sources.slice(offset, offset + 2);
    const values = await Promise.all(sourceslice.map((source) => repositoryMetadata(source.source)));
    values.forEach((value, index) => {
      output[offset + index] = value ?? { stars: null, repoUpdatedAt: null };
    });
  }
  return output;
}

export function catalogSources(): SkillCatalogSource[] {
  return [...SKILL_SOURCES, ...readonlyCatalogSources()];
}

export async function catalogDocument(): Promise<{
  sources: Array<SkillCatalogSource & RepositoryMetadata>;
  itemsBySource: Record<string, never>;
}> {
  const baseSources = catalogSources();
  const metadata = await catalogMetadata(baseSources);
  return {
    sources: baseSources.map((source, index) => ({ ...source, ...metadata[index]! })),
    itemsBySource: {},
  };
}
