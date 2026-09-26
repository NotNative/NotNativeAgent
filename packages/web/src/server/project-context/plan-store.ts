// SPDX-License-Identifier: Apache-2.0
/** Personal project plans: manifest in context.json, markdown under plans/. */
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ContextInputError, mutateProjectContext, projectContextPaths,
  readProjectContext, type ProjectContext } from './context-store.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';

export interface PlanManifest { id: string; file: string; title: string; createdAt: number; pinned?: boolean; source?: string }
export interface ProjectPlan extends PlanManifest { body: string; raw: string }

function plansIn(context: ProjectContext): PlanManifest[] {
  const ids = new Set<string>();
  const files = new Set<string>();
  return context.plans.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('malformed plan manifest');
    const plan = value as PlanManifest;
    if (typeof plan.id !== 'string' || !plan.id || typeof plan.file !== 'string'
      || !/^[A-Za-z0-9._-]+\.md$/u.test(plan.file) || plan.file.startsWith('.')) {
      throw new Error('malformed plan manifest');
    }
    // A portable manifest must not alias the same file on case-insensitive Windows volumes.
    const fileKey = plan.file.toLowerCase();
    if (ids.has(plan.id) || files.has(fileKey)) throw new Error('duplicate plan manifest entry');
    ids.add(plan.id);
    files.add(fileKey);
    return plan;
  });
}

async function checkedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe plan directory');
}

async function checkedPlanFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('unsafe plan file');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new ContextInputError('plan not found', 404);
    throw error;
  }
}

async function checkedPlanDirectory(path: string): Promise<void> {
  try {
    await checkedDirectory(dirname(path));
    await checkedDirectory(path);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new ContextInputError('plan not found', 404);
    throw error;
  }
}

function planFor(context: ProjectContext, planId: string): PlanManifest {
  const plan = plansIn(context).find((item) => item.id === planId);
  if (!plan) throw new ContextInputError('plan not found', 404);
  return plan;
}

function parsedMarkdown(raw: string): { title: string; body: string } {
  const lines = raw.replace(/\r\n/gu, '\n').split('\n');
  const first = lines[0] ?? '';
  if (first.startsWith('# ')) return { title: first.slice(2).trim(), body: lines.slice(1).join('\n').trim() };
  return { title: first.trim(), body: raw };
}

function validText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ContextInputError(`invalid plan ${name}`, 400);
  }
  return value.trim();
}

export async function readProjectPlan(projectId: string, planId: string): Promise<ProjectPlan> {
  const paths = projectContextPaths(projectId);
  const plan = planFor(await readProjectContext(projectId), planId);
  await checkedPlanDirectory(paths.plans);
  const file = join(paths.plans, plan.file);
  await checkedPlanFile(file);
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new ContextInputError('plan not found', 404);
    throw error;
  }
  return { ...plan, ...parsedMarkdown(raw), raw };
}

export async function createProjectPlan(projectId: string, input: { title?: unknown; body?: unknown }): Promise<{
  plan: PlanManifest; context: ProjectContext;
}> {
  const title = validText(input.title, 'title', 200);
  if (/[\r\n]/u.test(title)) throw new ContextInputError('invalid plan title', 400);
  const body = typeof input.body === 'string' && input.body.length <= 512 * 1024 ? input.body : null;
  if (body === null) throw new ContextInputError('invalid plan body', 400);
  const paths = projectContextPaths(projectId);
  return mutateProjectContext(projectId, async (current) => {
    const plans = plansIn(current);
    const id = randomUUID();
    const plan: PlanManifest = { id, file: `${Date.now()}-${id}.md`, title, createdAt: Date.now() };
    await mkdir(dirname(paths.plans), { recursive: true });
    await checkedDirectory(dirname(paths.plans));
    await mkdir(paths.plans, { recursive: true });
    await checkedPlanDirectory(paths.plans);
    await writeFile(join(paths.plans, plan.file), `# ${title}\n\n${body}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const context = { ...current, plans: [...plans, plan] };
    return { next: context, result: { plan, context } };
  });
}

export async function updateProjectPlan(projectId: string, planId: string, rawValue: unknown): Promise<{
  plan: PlanManifest; raw: string;
}> {
  if (typeof rawValue !== 'string' || rawValue.length > 512 * 1024) {
    throw new ContextInputError('invalid plan raw markdown', 400);
  }
  const raw = rawValue;
  const paths = projectContextPaths(projectId);
  // First access may migrate legacy links under the same config lock.
  await readProjectContext(projectId);
  return withConfigLock(paths.config, async () => {
    const plan = planFor(await readProjectContext(projectId), planId);
    await checkedPlanDirectory(paths.plans);
    const file = join(paths.plans, plan.file);
    await checkedPlanFile(file);
    const temp = `${file}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await checkedPlanFile(file); // refuse to recreate a file removed before replacement
      await rename(temp, file);
    } finally { await unlink(temp).catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }); }
    return { plan, raw };
  });
}

export async function deleteProjectPlan(projectId: string, planId: string): Promise<ProjectContext> {
  const paths = projectContextPaths(projectId);
  let file = '';
  const context = await mutateProjectContext(projectId, async (current) => {
    const plans = plansIn(current);
    const plan = planFor(current, planId);
    file = plan.file;
    await checkedPlanDirectory(paths.plans).catch((error: unknown) => {
      if (!(error instanceof ContextInputError) || error.status !== 404) throw error;
    });
    const next = { ...current, plans: plans.filter((item) => item.id !== planId) };
    return { next, result: next };
  });
  await checkedPlanDirectory(paths.plans).catch((error: unknown) => {
    if (!(error instanceof ContextInputError) || error.status !== 404) throw error;
  });
  await unlink(join(paths.plans, file)).catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  });
  return context;
}
