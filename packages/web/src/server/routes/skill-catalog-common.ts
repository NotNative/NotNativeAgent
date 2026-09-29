// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono';
import { readBoundedSkillBody } from './skill-support.ts';
import { CatalogScanError, scanCatalogSource } from '../lib/skills/skill-catalog-scan.ts';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/u;

export interface SkillCreateShape {
  description?: unknown; instructions?: unknown; source?: unknown; scope?: unknown;
  [key: string]: unknown;
}

export function skillNameValid(value: string): boolean {
  return SKILL_NAME.test(value) && value.length > 0 && value.length < 65;
}

export type ConflictPolicy = 'prompt' | 'skipAll' | 'overwriteAll';
export type TargetSource = 'opencode' | 'agents';

export interface ValidatedSkillInstall {
  source: string; subpath: string | null; gitIdentityId: string | null;
  scope: 'user' | 'project'; targetSource: TargetSource;
  selections: string[]; conflictPolicy: ConflictPolicy;
  conflictDecisions: Record<string, 'skip' | 'overwrite'>;
}

export function parseBoundedSkillBody(encodedBody: string): SkillCreateShape | null {
  try {
    const body = JSON.parse(encodedBody) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as SkillCreateShape;
  } catch { return null; }
}

export function catalogScanFailure(context: Context, error: unknown): Response {
  if (!(error instanceof CatalogScanError)) {
    return context.json({ error: { kind: 'unknown', message: 'Git source scan failed' } }, 500);
  }
  const status = error.kind === 'invalidSource' ? 400
    : error.kind === 'authRequired' ? 401
      : error.kind === 'networkError' ? 502 : 500;
  const identities = error.kind === 'authRequired' ? [] : undefined;
  return context.json({ error: { kind: error.kind, message: error.message, identities } }, status);
}

function boundedCatalogText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
    && !/\p{Control}/u.test(value);
}

export function validateSkillInstall(body: SkillCreateShape): { error: string } | ValidatedSkillInstall {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid install body' };
  const allowed = ['source', 'subpath', 'gitIdentityId', 'scope', 'targetSource', 'selections', 'conflictPolicy', 'conflictDecisions'];
  if (Object.keys(body).some((field) => !allowed.includes(field))) {
    return { error: 'unsupported install body field' };
  }
  const selections = body.selections;
  if (!Array.isArray(selections) || selections.length === 0 || selections.length > 200
    || selections.some((name) => typeof name !== 'string' || !skillNameValid(name))) {
    return { error: 'between 1 and 200 valid skill names are required' };
  }
  const uniqueSelections = [...new Set(selections as string[])];
  const targetSource = body.targetSource === undefined || body.targetSource === null
    ? 'opencode' : body.targetSource;
  if (targetSource !== 'opencode' && targetSource !== 'agents') {
    return { error: 'target source must be opencode or agents' };
  }
  const conflictPolicy = body.conflictPolicy === undefined || body.conflictPolicy === null
    ? 'prompt' : body.conflictPolicy;
  if (conflictPolicy !== 'prompt' && conflictPolicy !== 'skipAll' && conflictPolicy !== 'overwriteAll') {
    return { error: 'conflict policy is invalid' };
  }
  const rawDecisions = body.conflictDecisions;
  if (rawDecisions !== undefined && rawDecisions !== null
    && (!(rawDecisions instanceof Object) || Array.isArray(rawDecisions)
      || Object.keys(rawDecisions).length > 200)) {
    return { error: 'conflict decisions are invalid' };
  }
  const decisions: Record<string, 'skip' | 'overwrite'> = {};
  for (const [name, value] of Object.entries(rawDecisions ?? {})) {
    if (!skillNameValid(name) || (value !== 'skip' && value !== 'overwrite')) {
      return { error: 'conflict decisions are invalid' };
    }
    decisions[name] = value;
  }
  const requestedIdentity = body.gitIdentityId;
  if (requestedIdentity !== undefined && requestedIdentity !== null && typeof requestedIdentity !== 'string') {
    return { error: 'invalid Git identity reference' };
  }
  if (body.subpath !== undefined && body.subpath !== null
    && !boundedCatalogText(body.subpath, 256)) {
    return { error: 'invalid Git subpath' };
  }
  if (!boundedCatalogText(body.source, 512)) {
    return { error: 'invalid Git source' };
  }
  const scope = body.scope;
  if (scope !== 'user' && scope !== 'project') return { error: 'scope must be either user or project' };
  return {
    source: String(body.source ?? ''),
    subpath: body.subpath === undefined || body.subpath === null ? null : body.subpath,
    gitIdentityId: requestedIdentity === undefined || requestedIdentity === null ? null : requestedIdentity,
    scope: scope,
    targetSource: targetSource as TargetSource,
    selections: uniqueSelections,
    conflictPolicy: conflictPolicy as ConflictPolicy,
    conflictDecisions: decisions,
  };
}

export async function catalogScanBody(request: Request): Promise<SkillCreateShape | null> {
  const encodedBody = await readBoundedSkillBody(request);
  if (encodedBody === null) return null;
  return parseBoundedSkillBody(encodedBody);
}

export async function scanAdHocCatalog(context: Context, directory: string | undefined): Promise<Response> {
  const body = await catalogScanBody(context.req.raw);
  if (!body) return context.json({ error: { kind: 'invalidSource', message: 'invalid scan body' } }, 400);
  const requestedIdentity = body.gitIdentityId;
  if (requestedIdentity !== undefined && requestedIdentity !== null
    && typeof requestedIdentity !== 'string') {
    return context.json({ error: { kind: 'invalidSource', message: 'invalid Git identity reference' } }, 400);
  }
  try {
    const items = await scanCatalogSource({
      source: String(body.source ?? ''),
      subpath: typeof body.subpath === 'string' ? body.subpath : null,
      directory,
      gitIdentityId: requestedIdentity === undefined || requestedIdentity === null ? null : requestedIdentity,
    });
    return context.json({ ok: true, items });
  } catch (error) { return catalogScanFailure(context, error); }
}
