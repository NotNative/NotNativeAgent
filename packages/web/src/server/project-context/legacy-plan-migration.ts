// SPDX-License-Identifier: Apache-2.0
/** Bounded migration of legacy absolute plan links into context-owned files. */
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ProjectContext } from './context-store.ts';

interface Paths { config: string; context: string; plans: string }
interface LegacyLink { id: string; path: string; createdAt?: number; pinned?: boolean }
interface PlanLink { id: string; file: string; title: string; createdAt: number; pinned: boolean; source: 'personal' }

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${requireSeparator()}`) && !isAbsolute(rel));
}

function requireSeparator(): string { return process.platform === 'win32' ? '\\' : '/'; }

function checkedLink(value: unknown): LegacyLink {
  if (!value || typeof value !== 'object') throw new Error('malformed legacy plan link');
  const link = value as LegacyLink;
  if (typeof link.id !== 'string' || !/^[A-Za-z0-9._:-]+$/u.test(link.id)
    || typeof link.path !== 'string' || !isAbsolute(link.path) || extname(link.path).toLowerCase() !== '.md') {
    throw new Error('malformed legacy plan link');
  }
  return link;
}

async function safeSource(path: string, root: string, lexicalRoot: string): Promise<string | null> {
  // Reject even a missing path outside the store; ENOENT must not launder it.
  if (!within(resolve(path), lexicalRoot)) throw new Error('legacy plan path leaves project storage');
  let resolved: string;
  try { resolved = await realpath(path); }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  if (!within(resolved, root)) throw new Error('legacy plan path leaves project storage');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('unsafe legacy plan file');
  return resolved;
}

async function safeDestinationDirectory(paths: Paths): Promise<void> {
  await mkdir(dirname(paths.plans), { recursive: true });
  const parent = await lstat(dirname(paths.plans));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('unsafe context directory');
  await mkdir(paths.plans, { recursive: true });
  const plans = await lstat(paths.plans);
  if (plans.isSymbolicLink() || !plans.isDirectory()) throw new Error('unsafe plans directory');
}

async function installMarkdown(paths: Paths, source: string, content: Buffer): Promise<string> {
  await safeDestinationDirectory(paths);
  const base = basename(source);
  const file = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/u.test(base) && dirname(source) === resolve(paths.plans)
    ? base : `legacy-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.md`;
  const destination = join(paths.plans, file);
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe legacy plan destination');
    const existing = await readFile(destination);
    if (!existing.equals(content)) throw new Error('legacy plan destination collision');
    return file;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const temp = `${destination}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await link(temp, destination); // fail if another file appeared after the collision check
  } finally { await unlink(temp).catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }); }
  return file;
}

function titleOf(content: string): string {
  const first = content.replace(/\r\n/gu, '\n').split('\n')[0] ?? '';
  return first.startsWith('# ') ? first.slice(2).trim() : first.trim();
}

async function convertLinks(paths: Paths, links: unknown[]): Promise<PlanLink[]> {
  const lexicalRoot = resolve(dirname(paths.config));
  const root = await realpath(lexicalRoot);
  const converted: PlanLink[] = [];
  for (const item of links) {
    const link = checkedLink(item);
    const source = await safeSource(link.path, root, lexicalRoot);
    if (source === null) continue; // missing markdown was not usable before migration either
    const content = await readFile(source);
    if (content.byteLength > 512 * 1024) throw new Error('legacy plan too large');
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(content);
    const file = await installMarkdown(paths, source, content);
    converted.push({ id: link.id, file, title: titleOf(markdown),
      createdAt: typeof link.createdAt === 'number' ? link.createdAt : 0,
      pinned: link.pinned === true, source: 'personal' });
  }
  return converted;
}

export async function cleanupLegacyConfig(paths: Paths, config: Record<string, unknown>): Promise<void> {
  const remaining = { ...config };
  for (const key of ['projectNotes', 'projectTodos', 'projectPlanFiles', 'notes', 'todos', 'plans']) delete remaining[key];
  const temp = `${paths.config}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(remaining, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, paths.config);
  } finally { await unlink(temp).catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }); }
}

export async function migrateLegacyPlanLinks(paths: Paths, config: Record<string, unknown>, base: ProjectContext,
  commit: (next: ProjectContext) => Promise<void>): Promise<ProjectContext> {
  const raw = config.projectPlanFiles;
  if (!Array.isArray(raw)) throw new Error('malformed legacy plan links');
  const links = await convertLinks(paths, raw);
  const plans = [...base.plans, ...links];
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const plan of plans) {
    if (!plan || typeof plan !== 'object') throw new Error('malformed legacy plan manifest');
    const item = plan as PlanLink;
    if (typeof item.id !== 'string' || !item.id || typeof item.file !== 'string'
      || !/^[A-Za-z0-9._-]+\.md$/u.test(item.file) || item.file.startsWith('.')
      || ids.has(item.id) || files.has(item.file.toLowerCase())) throw new Error('ambiguous legacy plan manifest');
    ids.add(item.id); files.add(item.file.toLowerCase());
  }
  const context = { ...base, plans };
  await commit(context); // durable first; config cleanup failure leaves a recoverable duplicate source
  await cleanupLegacyConfig(paths, config);
  return context;
}
