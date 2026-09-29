// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono';
import { SkillInstallError, catalogConflicts, installSelectedSkills } from '../lib/skills/skill-catalog-installer.ts';
import { catalogScanBody, validateSkillInstall, type ValidatedSkillInstall } from './skill-catalog-common.ts';
import { canonicalProjectCheckout } from './skills.ts';

function installFailure(context: Context, error: unknown): Response {
  if (error instanceof SkillInstallError) {
    const status = error.kind === 'invalidSource' ? 400
      : error.kind === 'authRequired' ? 401
        : error.kind === 'networkError' ? 502 : 500;
    const identities = error.kind === 'authRequired' ? [] : undefined;
    return context.json({ error: { kind: error.kind, message: error.message, identities } }, status);
  }
  return context.json({ error: { kind: 'unknown', message: 'skill installation failed' } }, 500);
}

async function installCatalogSkills(context: Context, checkout: string | null,
  request: ValidatedSkillInstall): Promise<Response> {
  const decisions = request.conflictDecisions;
  const allConflicts = catalogConflicts({
    scope: request.scope, targetSource: request.targetSource, checkout,
    selectedNames: request.selections,
  });
  const targetConflicts = allConflicts.filter((conflict) =>
    conflict.scope === request.scope && conflict.source === request.targetSource);
  const unresolved = targetConflicts.filter((conflict) =>
    request.conflictPolicy !== 'skipAll' && request.conflictPolicy !== 'overwriteAll'
    && decisions[conflict.skillName] !== 'skip' && decisions[conflict.skillName] !== 'overwrite');
  if (unresolved.length > 0) {
    return context.json({
      error: { kind: 'conflicts', message: 'skills already exist', conflicts: allConflicts },
    }, 409);
  }
  const skipped = targetConflicts
    .filter((conflict) =>
      request.conflictPolicy === 'skipAll' || decisions[conflict.skillName] === 'skip')
    .map((conflict) => ({
      skillName: conflict.skillName,
      reason: 'conflict' as const,
      scope: conflict.scope,
      source: conflict.source,
    }));
  const selected = request.selections.filter((skillName) => !skipped.some((entry) => entry.skillName === skillName));
  if (selected.length === 0) {
    return context.json({
      ok: true, installed: [], skipped,
      requiresReload: true, message: 'no new skills installed', reloadDelayMs: 500,
    });
  }
  try {
    const overwriteNames = targetConflicts
      .filter((conflict) =>
        request.conflictPolicy === 'overwriteAll'
        || (request.conflictPolicy === 'prompt' && decisions[conflict.skillName] === 'overwrite'))
      .map((conflict) => conflict.skillName);
    const skills = await installSelectedSkills(
      {
        source: request.source, subpath: request.subpath, selectedNames: selected,
        overwriteNames,
      },
      { scope: request.scope, targetSource: request.targetSource, checkout },
    );
    return context.json({
      ok: true, installed: skills, skipped,
      requiresReload: true, message: 'skills installed; reload before use', reloadDelayMs: 500,
    });
  } catch (error) { return installFailure(context, error); }
}

export async function installCatalog(context: Context, requestedDirectory: string): Promise<Response> {
  const body = await catalogScanBody(context.req.raw);
  if (!body) {
    return context.json({ error: { kind: 'invalidSource', message: 'invalid install body' } }, 400);
  }
  const validated = validateSkillInstall(body);
  if ('error' in validated) {
    return context.json({ error: { kind: 'invalidSource', message: validated.error } }, 400);
  }
  if (validated.gitIdentityId !== null) {
    return context.json({
      error: { kind: 'invalidSource', message: 'Git identity installing is not yet configured' },
    }, 400);
  }
  let checkout: string | null = null;
  if (validated.scope === 'project') {
    checkout = canonicalProjectCheckout(requestedDirectory);
    if (checkout === null) {
      return context.json({
        error: { kind: 'invalidSource', message: 'project checkout directory is required' },
      }, 400);
    }
  }
  return installCatalogSkills(context, checkout, validated);
}
