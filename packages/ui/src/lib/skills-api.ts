// SPDX-License-Identifier: Apache-2.0
/** Typed skills/catalog transport over the NND app origin via runtimeFetch. */
import { runtimeFetch } from './runtime-fetch.ts';

export type SkillScope = 'user' | 'project';
export type SkillTargetSource = 'opencode' | 'agents';

export interface SkillSource {
  id: string;
  label: string;
  source: string;
  subpath?: string | null;
  defaultSubpath?: string | null;
  gitIdentityId?: string | null;
  stars?: number | null;
  repoUpdatedAt?: string | null;
}

export interface SkillCatalogScanItem {
  repoSource: string;
  repoSubpath: string | null;
  skillDir: string;
  skillName: string;
  frontmatterName: string;
  description: string;
  installable: boolean;
  warnings: string[];
  installed: { isInstalled: boolean; scope: SkillScope | null; source: string | null };
}

export interface SkillSummary {
  name: string;
  path: string;
  scope: SkillScope;
  source: string;
  description: string;
  [key: string]: unknown;
}

export interface SkillCatalog {
  ok: true;
  sources: SkillSource[];
  itemsBySource: Record<string, SkillCatalogScanItem[]>;
}

export interface SkillConflict {
  skillName: string;
  path: string;
  scope: SkillScope;
  source: string;
}

export interface SkillInstallResult {
  ok: true;
  installed: Array<{ skillName: string; scope: SkillScope; source: string }>;
  skipped: Array<{ skillName: string; reason: 'conflict'; scope?: string; source?: string }>;
  requiresReload: boolean;
  message: string;
  reloadDelayMs?: number;
}

export interface SkillInstallRequest {
  source: string;
  subpath?: string | null;
  gitIdentityId?: string | null;
  scope: SkillScope;
  targetSource?: SkillTargetSource;
  selections: string[];
  conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
  conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
}

export interface SkillIdentity {
  id: string;
  name: string;
}

export type SkillApiErrorKind = 'authRequired' | 'networkError' | 'invalidSource' | 'conflicts' | 'unknown';

export class SkillApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: SkillApiErrorKind,
    message: string,
    readonly identities?: SkillIdentity[],
    readonly conflicts?: SkillConflict[],
) {
    super(message);
  }
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function directoryQuery(directory: string | undefined, extra: Record<string, string | undefined> = {}): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) parameters.set(key, value);
  }
  if (directory !== undefined && directory !== '') parameters.set('directory', directory);
  const text = parameters.toString();
  return text === '' ? '' : `?${text}`;
}

function errorDetail(value: unknown, status: number): SkillApiError {
  type ErrorDetailBody = { kind?: unknown; message?: unknown; identities?: unknown; conflicts?: unknown };
  const record = value as { error?: unknown } | null;
  const detail = record?.error as ErrorDetailBody | string | null | undefined;
  if (typeof detail === 'string') return new SkillApiError(status, 'unknown', detail);
  const kind = detail?.kind as SkillApiErrorKind | undefined;
  const known = kind === 'authRequired' || kind === 'conflicts' || kind === 'invalidSource'
    || kind === 'networkError' || kind === 'unknown';
  return new SkillApiError(status, known ? kind : 'unknown',
    typeof detail?.message === 'string' ? detail.message : `skills request failed (${status})`,
    Array.isArray(detail?.identities) ? detail.identities : undefined,
    Array.isArray(detail?.conflicts) ? detail.conflicts : undefined);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await runtimeFetch(path, init);
  let value: unknown = {};
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) throw errorDetail(value, response.status);
  return value as T;
}

export function listSkills(directory?: string): Promise<{ skills: SkillSummary[]; externalSkills: Record<string, boolean> }> {
  return request(`/api/config/skills${directoryQuery(directory)}`);
}

export function loadSkillCatalog(): Promise<SkillCatalog> {
  return request('/api/config/skills/catalog');
}

export function loadSkillCatalogSource(sourceId: string, options: {
  directory?: string; refresh?: boolean;
} = {}): Promise<{ ok: true; source: SkillSource; sourceId: string; items: SkillCatalogScanItem[] }> {
  if (!sourceId || /[/\\?#\p{Control}]/u.test(sourceId)) throw new SkillApiError(400, 'invalidSource', 'Invalid source ID');
  return request(`/api/config/skills/catalog/source${directoryQuery(options.directory, {
    sourceId: encodeURIComponent(sourceId), refresh: options.refresh === true ? 'true' : undefined,
  })}`);
}

export function scanSkills(requestBody: {
  source: string; subpath?: string | null; gitIdentityId?: string | null;
}): Promise<{ ok: true; items: SkillCatalogScanItem[] }> {
  return request('/api/config/skills/scan', jsonBody('POST', requestBody));
}

export function installSkills(requestBody: SkillInstallRequest, directory?: string): Promise<SkillInstallResult> {
  if (requestBody.scope === 'project' && !directory) throw new SkillApiError(400, 'invalidSource', 'Project checkout directory is required');
  return request(`/api/config/skills/install${directoryQuery(directory)}`, jsonBody('POST', requestBody));
}
