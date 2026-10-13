// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono';
import { closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync,
  statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { directAbsolute, scanLocalSkills } from '../lib/skills/skill-scan.ts';

const MAX_SUPPORTING_FILE_BYTES = 2 * 1024 * 1024;

export function skillSupportRelativePath(context: Context): string | null {
  const path = new URL(context.req.raw.url).pathname;
  const marker = '/files/';
  const start = path.indexOf(marker);
  if (start < 0) return '';
  const encoded = path.slice(start + marker.length);
  if (encoded === '') return '';
  try { return decodeURIComponent(encoded); } catch { return null; }
}

export async function readBoundedSkillBody(raw: Request): Promise<string | null> {
  const reader = raw.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let next = await reader.read();
  while (!next.done) {
    const chunk = next.value ?? new Uint8Array(0);
    chunks.push(chunk);
    byteLength += chunk.byteLength;
    if (byteLength > MAX_SUPPORTING_FILE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    next = await reader.read();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function absoluteLike(value: string): boolean {
  return /^([A-Za-z]:)?[\\/]/u.test(value);
}

function managedSkill(name: string, requestedDirectory: string) {
  const scope = requestedDirectory === '' ? 'user' : 'project';
  const searchDirectory = requestedDirectory === '' ? homedir() : requestedDirectory;
  return scanLocalSkills(searchDirectory).find((entry) => entry.name === name && entry.scope === scope);
}

function skillEditable(skill: ReturnType<typeof scanLocalSkills>[number] | undefined): boolean {
  return skill?.renamable === true && skill.source === 'opencode';
}

function storageStatus(error: unknown): 403 | 404 | 500 {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 403;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 404;
  return 500;
}

function containsInside(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === '' || !distance.startsWith('..') && !isAbsolute(distance);
}

function containsSymlinkFree(skillDirectory: string, target: string): boolean {
  let current = target;
  while (containsInside(skillDirectory, current)) {
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if ((metadata?.isSymbolicLink?.()) === true) return false;
    if (current === skillDirectory) return true;
    current = join(current, '..');
  }
  return false;
}

function supportFilePath(skill: ReturnType<typeof scanLocalSkills>[number], requestedPath: string): string | null {
  const root = join(skill.path, '..');
  if (requestedPath === '' || absoluteLike(requestedPath)) return null;
  const segments = requestedPath.split(/[\\/]+/u);
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) return null;
  if (segments.some((segment) => segment.toLowerCase() === 'skill.md')) return null;
  const target = join(root, ...segments);
  return containsInside(root, target) ? target : null;
}

interface SupportResolution {
  readonly response: Response;
  readonly target?: string;
}

function resolveSupportFile(context: Context, name: string, rawPath: string,
  directory: string): SupportResolution {
  const skill = managedSkill(name, directory);
  if (!skill) {
    return { response: context.json({ error: 'skill not found' }, 404) };
  }
  if (!skillEditable(skill)) {
    return { response: context.json({ error: 'skill is not managed here' }, 403) };
  }
  const target = supportFilePath(skill, rawPath);
  if (target === null || !containsSymlinkFree(join(skill.path, '..'), target)) {
    return { response: context.json({ error: 'invalid supporting file path' }, 400) };
  }
  return { target, response: context.json({ error: 'unexpected supporting file error' }, 500) };
}

function readSupportFile(context: Context, target: string, rawPath: string): Response {
  try {
    if (statSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
      return context.json({ error: 'supporting file not found' }, 404);
    }
    const handle = openSync(target, 'r');
    try {
      const metadata = fstatSync(handle);
      if (metadata.isFile() !== true) return context.json({ error: 'supporting file not found' }, 404);
      const length = Math.min(metadata.size, MAX_SUPPORTING_FILE_BYTES + 1);
      const buffer = Buffer.alloc(length);
      const bytes = readSync(handle, buffer, 0, length, 0);
      if (bytes > MAX_SUPPORTING_FILE_BYTES) {
        return context.json({ error: 'supporting file is too large' }, 413);
      }
      return context.json({ path: rawPath, content: buffer.subarray(0, bytes).toString('utf8') });
    } finally { closeSync(handle); }
  } catch (error) {
    return context.json({ error: 'supporting file storage failed' }, storageStatus(error));
  }
}

function writeSupportFile(context: Context, target: string, content: string): Response {
  let temporary: string | null = null;
  try {
    if (statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      return context.json({ error: 'supporting file path is a directory' }, 400);
    }
    mkdirSync(join(target, '..'), { recursive: true });
    const canonicalRoot = realpathSync(join(target, '..', '..'));
    if (!containsInside(canonicalRoot, realpathSync(join(target, '..')))) {
      return context.json({ error: 'invalid supporting file path' }, 400);
    }
    temporary = join(target, '..', `.support.tmp-${randomUUID()}`);
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try {
      if (statSync(target, { throwIfNoEntry: false })) unlinkSync(target);
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EACCES' || (error as NodeJS.ErrnoException | null)?.code === 'EPERM') {
        return context.json({ error: 'supporting file storage forbidden' }, 403);
      }
      throw error;
    }
    return context.json({
      requiresReload: true, message: 'supporting file saved; reload before use',
      reloadDelayMs: 500,
    }, 201);
  } catch (error) {
    return context.json({ error: 'supporting file storage failed' }, storageStatus(error));
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* response already resolved */ } }
  }
}

export function readSkillSupportingFile(context: Context, name: string,
  requestedDirectory: string): Response {
  const filePath = skillSupportRelativePath(context);
  if (filePath === null) return context.json({ error: 'invalid supporting file path' }, 400);
  const resolution = resolveSupportFile(context, name, filePath, requestedDirectory);
  return resolution.target === undefined ? resolution.response : readSupportFile(context, resolution.target, filePath);
}

export function writeSkillSupportingFile(context: Context, name: string, content: string,
  requestedDirectory: string): Response {
  const filePath = skillSupportRelativePath(context);
  if (filePath === null) return context.json({ error: 'invalid supporting file path' }, 400);
  const resolution = resolveSupportFile(context, name, filePath, requestedDirectory);
  return resolution.target === undefined ? resolution.response : writeSupportFile(context, resolution.target, content);
}

export function deleteSkillSupportingFile(context: Context, name: string,
  requestedDirectory: string): Response {
  const filePath = skillSupportRelativePath(context);
  if (filePath === null) return context.json({ error: 'invalid supporting file path' }, 400);
  const resolution = resolveSupportFile(context, name, filePath, requestedDirectory);
  if (resolution.target === undefined) return resolution.response;
  try {
    unlinkSync(resolution.target);
    return context.json({
      requiresReload: true, message: 'supporting file deleted; reload before use', reloadDelayMs: 500,
    }, 201);
  } catch (error) {
    return context.json({ error: 'supporting file storage failed' }, storageStatus(error));
  }
}
