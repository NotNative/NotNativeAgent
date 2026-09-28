// SPDX-License-Identifier: Apache-2.0
/** Shared repository plans and the two safe transfers across the manifest. */
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { ContextInputError, mutateProjectContext, projectContextPaths, readProjectContext,
  type ProjectContext } from './context-store.ts';

export interface SharedPlanManifest { id: string; file: string; title: string; createdAt: number; source: 'shared' }
export interface ProjectContextWithShared extends ProjectContext { sharedPlansDir?: string }

const PLAN_FILE =
  /^[^/\\<>:"|?*\u0000-\u001f\u007f][^/\\<>:"|?*\u0000-\u001f\u007f]*\.(?:md|MD)$/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const PLAN_BODY_MAX = 512 * 1024;

export function projectPlanFileValid(file: string): boolean {
  if (!/^[^/\\<>:"|?*\u0000-\u001f\u007f][^/\\<>:"|?*\u0000-\u001f\u007f]*\.(?:md|MD)$/u.test(file)
    || file.startsWith('.') || file.endsWith('.') || file.endsWith(' ')) return false;
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(parse(file).base);
}

export function checkoutRoot(checkout: unknown): string {
  if (typeof checkout !== 'string' || checkout.trim() === '' || !isAbsolute(checkout)) {
    throw new ContextInputError('project checkout directory is required', 400);
  }
  return checkout;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string }).code === 'ENOENT';
}

async function checkedDirectory(path: string, onMissing: 'reject' | 'create', message = 'unsafe plan directory'): Promise<void> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (!isMissing(error)) throw error;
    if (onMissing === 'reject') throw new ContextInputError(message, 400);
    await mkdir(path, { recursive: true });
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ContextInputError(message, 400);
}

async function checkedFile(path: string, missingStatus: 400 | 404, message = 'plan not found'): Promise<void> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (isMissing(error)) throw new ContextInputError(message, missingStatus);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new ContextInputError('unsafe plan file', 400);
}

function checkedDirectoryChain(root: string, target: string): void {
  let current = root;
  for (const segment of target.slice(root.length).split(/[\\/]+/u).filter((value) => value !== '')) {
    if (segment === '..') throw new ContextInputError('unsafe plan directory', 400);
    current = join(current, segment);
  }
}

function isPlanFile(file: string): boolean {
  if (!PLAN_FILE.test(file) || file.startsWith('.') || file.endsWith('.') || file.endsWith(' ')) return false;
  return !WINDOWS_RESERVED.test(parse(file).base);
}

function teamPlansDirectory(root: string, acceptMissingShared = false): Promise<string | null> {
  const configPath = join(root, '.openchamber', 'project.json');
  return (async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(configPath, 'utf8')); }
    catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof SyntaxError) throw new ContextInputError('invalid team plan configuration', 400);
      throw error;
    }
    const raw = parsed as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ContextInputError('invalid team plan configuration', 400);
    }
    const configured = (raw as Record<string, unknown>).plansDir;
    if (typeof configured !== 'string' || configured.trim() === '') {
      throw new ContextInputError('invalid team plan directory', 400);
    }
    const target = resolve(root, configured);
    const nominal = relative(root, target);
    if (isAbsolute(configured) || nominal === '' || nominal.split(/[\\/]/u)[0] === '..') {
      throw new ContextInputError('nested team plan directory is required', 400);
    }
    checkedDirectoryChain(root, target);
    await checkedDirectory(target, 'reject', 'shared plans directory not found');
    return target;
  })();
}

export async function requireSharedPlansDirectory(checkout: unknown, create = false,
  acceptMissingShared = false): Promise<string> {
  const root = checkoutRoot(checkout);
  await checkedDirectory(root, 'reject', 'project checkout directory not found');
  await checkedDirectory(join(root, '.openchamber'), create ? 'create' : 'reject',
    'unsafe team-plan parent directory');
  const custom = await teamPlansDirectory(root, false);
  const shared = custom ?? join(root, '.openchamber', 'plans');
  if (create || !acceptMissingShared) {
    await checkedDirectory(shared, create ? 'create' : 'reject', create ? 'unsafe team-plan directory' : 'shared plans directory not found');
  } else {
    let info;
    try { info = await lstat(shared); }
    catch (error) {
      if (!isMissing(error)) throw error;
      return shared;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ContextInputError('unsafe plan directory', 400);
  }
  return shared;
}

export function planFileName(plan: unknown): string | null {
  if (!plan || typeof plan !== 'object') return null;
  const file = (plan as { file?: unknown }).file;
  return typeof file === 'string' && isPlanFile(file) ? file : null;
}

export function unclaimedFile(planId: string): string | null {
  const prefix = 'shared:';
  if (!planId.startsWith(prefix)) return null;
  const file = planId.slice(prefix.length);
  return isPlanFile(file) ? file : null;
}

function firstHeading(raw: string): string {
  return raw.replace(/\r\n/gu, '\n').split('\n')[0]!.trim().replace(/^#\s+/u, '') || 'Untitled plan';
}

export async function readContextWithShared(projectId: string, checkout: unknown): Promise<ProjectContextWithShared> {
  const context = await readProjectContext(projectId);
  const shared = await requireSharedPlansDirectory(checkout, false, true);
  const claimedFiles = new Set(context.plans
    .filter((item) => !!item && typeof item === 'object' && (item as { shared?: unknown }).shared === true)
    .map(planFileName)
    .filter((file): file is string => file !== null)
    .map((file) => file.toLowerCase()));
  const entries = await readdir(shared, { withFileTypes: true });
  const sharedPlans = (await Promise.all(entries.map(async (entry) => {
    if (entry.isSymbolicLink() || !entry.isFile() || !PLAN_FILE.test(entry.name) || entry.name.startsWith('.')) return null;
    const path = join(shared, entry.name);
    await checkedFile(path, 404);
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { id: `shared:${entry.name}`, file: entry.name, title: firstHeading(raw), createdAt: info.mtimeMs, source: 'shared' };
  }))).filter((item): item is SharedPlanManifest => item !== null)
    .filter((item) => !claimedFiles.has(item.file.toLowerCase()));
  const plans = [
    ...context.plans.map((item) => item && typeof item === 'object' && (item as { source?: unknown }).source === undefined
      ? { ...(item as Record<string, unknown>), source: 'personal' } : item),
    ...sharedPlans,
  ];
  return { ...context, plans, sharedPlansDir: shared };
}

function contextWithSharedDir(context: ProjectContext, sharedPlansDir: string): ProjectContextWithShared {
  return { ...context, sharedPlansDir };
}

function declaredSharedPlan(context: ProjectContext, planId: string): { index: number; plan: Record<string, unknown> } | null {
  const index = context.plans.findIndex((item) => !!item && typeof item === 'object'
    && (item as { id?: unknown }).id === planId && (item as { shared?: unknown }).shared === true);
  return index < 0 ? null : { index, plan: context.plans[index] as Record<string, unknown> };
}

async function copyPlanWithinLock(source: string, directory: string, targetFile: string): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, await readFile(source), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { await rename(temporary, join(directory, targetFile)); }
  finally { await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; }); }
}

async function removeQuietly(path: string): Promise<boolean> {
  try { await unlink(path); return true; }
  catch (error) { return isMissing(error); }
}

function withPlansDirectoryLock<T>(directory: string, callback: () => Promise<T>): Promise<T> {
  return withConfigLock(join(directory, '.plans.lock'), callback);
}

export async function sharePlan(projectId: string, planId: string, checkout: unknown): Promise<{
  plan: Record<string, unknown>; sharedPlansDir: string; context: ProjectContextWithShared;
}> {
  const shared = await requireSharedPlansDirectory(checkout, true);
  return withPlansDirectoryLock(shared, async () => {
    const personal = projectContextPaths(projectId).plans;
    await checkedDirectory(personal, 'reject', 'personal plans directory not found');
    const prior = await readProjectContext(projectId);
    const priorIndex = prior.plans.findIndex((item) => !!item && typeof item === 'object'
      && (item as { id?: unknown }).id === planId && (item as { shared?: unknown }).shared !== true);
    if (priorIndex < 0) throw new ContextInputError('plan not found', 404);
    const sourceFile = planFileName(prior.plans[priorIndex]);
    if (!sourceFile) throw new Error('malformed plan manifest');
    const source = join(personal, sourceFile);
    await checkedFile(source, 404);
    const sourceInfo = await lstat(source);
    if (sourceInfo.size > PLAN_BODY_MAX) throw new ContextInputError('plan file exceeds the size limit', 400);
    const targetFile = uniqueFile(await immediateFiles(shared), sourceFile);
    const copied = await mutateProjectContext(projectId, async (next) => {
      const claimedIndex = next.plans.findIndex((item) => !!item && typeof item === 'object'
        && (item as { id?: unknown }).id === planId && (item as { shared?: unknown }).shared !== true);
      if (claimedIndex < 0 || planFileName(next.plans[claimedIndex]) !== sourceFile) {
        throw new ContextInputError('plan changed; refresh and retry', 409);
      }
      await copyPlanWithinLock(source, shared, targetFile);
      const plan = { ...(next.plans[claimedIndex] as Record<string, unknown>), file: targetFile, shared: true };
      const plans = next.plans.map((item, index) => index === claimedIndex ? plan : item);
      const context = { ...next, plans };
      return { next: context, result: { plan, sharedPlansDir: shared, context: contextWithSharedDir(context, shared) } };
    });
    if (!await removeQuietly(source)) throw new Error('personal plan duplicate cleanup failed');
    return copied;
  });
}

type SharedTarget = { kind: 'personal' } | { kind: 'shared'; file: string | null; manifest: Record<string, unknown> | null };

function uniqueFile(existing: ReadonlySet<string>, originalFile: string): string {
  const parts = parse(originalFile);
  let file = originalFile;
  let index = 1;
  while (existing.has(file.toLowerCase())) {
    file = `${parts.name}-${index}${parts.ext}`;
    index += 1;
  }
  if (!PLAN_FILE.test(file) || file.startsWith('.')) throw new Error('plan file escape rejected');
  return file;
}

function sharedTarget(context: ProjectContext, planId: string): SharedTarget {
  const manifest = context.plans.find((item) => !!item && typeof item === 'object'
    && (item as { id?: unknown }).id === planId) as Record<string, unknown> | undefined;
  if (manifest && (manifest as { shared?: unknown }).shared !== true) return { kind: 'personal' };
  const file = manifest ? planFileName(manifest) : unclaimedFile(planId);
  return { kind: 'shared', file, manifest: manifest ?? null };
}

async function readSharedFile(projectId: string, planId: string, checkout: unknown): Promise<{
  plan: Record<string, unknown>; raw: string; sharedPlansDir: string;
}> {
  const context = await readProjectContext(projectId);
  const target = sharedTarget(context, planId);
  if (target.kind !== 'shared' || !target.file) throw new ContextInputError('plan not found', 404);
  const sharedPlansDir = await requireSharedPlansDirectory(checkout);
  const file = join(sharedPlansDir, target.file);
  await checkedFile(file, 404);
  const raw = await readFile(file, 'utf8');
  const plan: Record<string, unknown> = target.manifest
    ? { ...target.manifest, title: firstHeading(raw) }
    : { id: planId, file: target.file, title: firstHeading(raw), createdAt: 0, source: 'shared' };
  return {
    plan: { ...plan, body: raw.startsWith('# ') ? raw.replace(/\r\n/gu, '\n').split('\n').slice(1).join('\n').trim() : raw, raw },
    raw, sharedPlansDir,
  };
}

export async function readSharedPlan(projectId: string, planId: string, checkout: unknown): Promise<Record<string, unknown>> {
  if (unclaimedFile(planId) === null && checkout === undefined) {
    const context = await readProjectContext(projectId);
    if (!context.plans.some((item) => !!item && typeof item === 'object' && (item as { id?: unknown }).id === planId)) {
      throw new ContextInputError('plan not found', 404);
    }
  }
  return (await readSharedFile(projectId, planId, checkout)).plan;
}

export async function updateSharedPlan(projectId: string, planId: string, rawValue: unknown, checkout: unknown): Promise<{
  plan: Record<string, unknown>; raw: string; sharedPlansDir: string;
}> {
  if (typeof rawValue !== 'string' || rawValue.length > PLAN_BODY_MAX) throw new ContextInputError('invalid plan raw markdown', 400);
  const sharedPlansDir = await requireSharedPlansDirectory(checkout);
  return withPlansDirectoryLock(sharedPlansDir, async () => {
    const context = await readProjectContext(projectId);
    const target = sharedTarget(context, planId);
    if (target.kind !== 'shared' || !target.file) throw new ContextInputError('plan not found', 404);
    const file = join(sharedPlansDir, target.file);
    await checkedFile(file, 404);
    const temporary = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(temporary, rawValue, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    }
    if (!target.manifest) {
      return { plan: { id: planId, file: target.file, title: firstHeading(rawValue), source: 'shared' }, raw: rawValue, sharedPlansDir };
    }
    return mutateProjectContext(projectId, (next) => {
      const latest = sharedTarget(next, planId);
      if (latest.kind !== 'shared' || !latest.file || latest.manifest?.file !== target.file) {
        throw new ContextInputError('plan changed; refresh and retry', 409);
      }
      const updated = { ...latest.manifest, title: firstHeading(rawValue) };
      const plans = next.plans.map((item) => item && typeof item === 'object' && (item as { id?: unknown }).id === planId
        ? updated : item);
      const changed = { ...next, plans };
      return { next: changed, result: { plan: updated, raw: rawValue, sharedPlansDir } };
    });
  });
}

export async function deleteSharedPlan(projectId: string, planId: string, checkout: unknown): Promise<ProjectContextWithShared> {
  const sharedPlansDir = await requireSharedPlansDirectory(checkout);
  return withPlansDirectoryLock(sharedPlansDir, async () => {
    const prior = await readProjectContext(projectId);
    const target = sharedTarget(prior, planId);
    if (target.kind !== 'shared' || !target.file) throw new ContextInputError('plan not found', 404);
    const file = join(sharedPlansDir, target.file);
    let context: ProjectContextWithShared;
    if (target.manifest) {
      context = await mutateProjectContext(projectId, (next) => {
        const latest = sharedTarget(next, planId);
        if (latest.kind !== 'shared' || !latest.file || latest.manifest?.file !== target.file) {
          throw new ContextInputError('plan changed; refresh and retry', 409);
        }
        const plans = next.plans.filter((item) => !(item && typeof item === 'object'
          && (item as { id?: unknown }).id === planId));
        const changed = { ...next, plans };
        return { next: changed, result: contextWithSharedDir(changed, sharedPlansDir) };
      });
      await unlinkFile(file);
      return context;
    }
    await checkedFile(file, 404);
    await unlinkFile(file);
    return contextWithSharedDir(prior, sharedPlansDir);
  });
}
async function unlinkFile(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) { if (!isMissing(error)) throw error; }
}

export async function unsharePlan(projectId: string, planId: string, checkout: unknown): Promise<{
  plan: Record<string, unknown>; sharedPlansDir: string; context: ProjectContextWithShared;
}> {
  const shared = await requireSharedPlansDirectory(checkout);
  return withPlansDirectoryLock(shared, async () => {
    const prior = await readProjectContext(projectId);
    const declared = declaredSharedPlan(prior, planId);
    const sourceFile = declared ? planFileName(declared.plan) : unclaimedFile(planId);
    if (!sourceFile) throw new Error('malformed plan manifest');
    const source = join(shared, sourceFile);
    await checkedFile(source, 404);
    const personal = projectContextPaths(projectId).plans;
    await checkedDirectory(personal, 'create');
    const targetFile = uniqueFile(await immediateFiles(personal), sourceFile);
    let plan;
    let resultContext;
    if (declared) {
      const moved = { ...declared.plan, file: targetFile, shared: false };
      const result = await mutateProjectContext(projectId, async (next) => {
        const latest = declaredSharedPlan(next, planId);
        if (!latest || planFileName(latest.plan) !== sourceFile) {
          throw new ContextInputError('plan changed; refresh and retry', 409);
        }
        await copyPlanWithinLock(source, personal, targetFile);
        const plans = next.plans.map((item, index) => index === latest.index ? moved : item);
        const changed = { ...next, plans };
        return { next: changed, result: { plan: moved, sharedPlansDir: shared, context: contextWithSharedDir(changed, shared) } };
      });
      plan = result.plan;
      resultContext = result.context;
    } else {
      const manifest = { id: randomUUID(), file: targetFile, title: firstHeading(await readFile(source, 'utf8')), createdAt: Date.now() };
      const result = await mutateProjectContext(projectId, async (next) => {
        if (unclaimedFile(planId) !== sourceFile) throw new ContextInputError('plan changed; refresh and retry', 409);
        await copyPlanWithinLock(source, personal, targetFile);
        const changed = { ...next, plans: [...next.plans, manifest] };
        return { next: changed, result: { plan: manifest, sharedPlansDir: shared, context: contextWithSharedDir(changed, shared) } };
      });
      plan = result.plan;
      resultContext = result.context;
    }
    if (!await removeQuietly(source)) throw new Error('shared plan retained; duplicate cleanup failed');
    return { plan, sharedPlansDir: shared, context: resultContext! };
  });
}

async function immediateFiles(path: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile()) names.add(entry.name.toLowerCase());
  }
  return names;
}
