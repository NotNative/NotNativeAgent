// SPDX-License-Identifier: Apache-2.0
/**
 * P4-3 fs write family (doc 03 §5.14 core): mkdir/write/delete/rename — all
 * workspace-bound (containment per routes/fs.ts resolution rules), atomic
 * tmp+rename for write, rename within the single ?directory workspace, delete
 * is rm -rf semantics with scope-root refusal, 404 on missing targets.
 */
import { existsSync, mkdirSync, renameSync, rmSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Hono, Context } from 'hono';
import { resolveWithin, realpath } from './fs.ts';

const WRITE_MAX_BYTES = 25 * 1024 * 1024;

function containedReal(scopeDir: string, target: string): boolean {
  // Single clause (review F4): BOTH endpoints realpath'd, lexical mismatch
  // against the junctioned ?directory no longer false-403s.
  return resolveWithin(realpath(scopeDir), realpath(target)) !== null;
}

interface PathBody { path?: string; allowOutsideWorkspace?: boolean }
interface ContentBody { path?: string; content?: string; expectedContent?: string }
interface RenameBody { oldPath?: string; newPath?: string }

async function pickBody<T extends object>(c: Context): Promise<T | null> {
  return c.req.json().catch(() => null) as Promise<T | null>;
}

function requireContext(c: Context): { ok: true; scopeDir: string } | { ok: false; response: Response } {
  const directory = c.req.query('directory');
  if (!directory) {
    return { ok: false, response: Response.json({ error: 'directory parameter is required' }, { status: 400 }) };
  }
  return { ok: true, scopeDir: directory };
}

function denied(): Response {
  return Response.json({ error: 'Access denied' }, { status: 403 });
}

/** §5.14 write family (carried-over P4-3 register): identical content skips
 * the atomic rewrite — mtime must not churn for editor autosave loops. */
function isContentNoOp(target: string, content: string): boolean {
  try {
    if (!existsSync(target) || !statSync(target).isFile()) return false;
    return readFileSync(target).equals(Buffer.from(content, 'utf8'));
  } catch {
    return false; // unreadable existing file: treat as a real write
  }
}

function fsFailed(error: unknown): Response {
  const code = (error as { code?: string }).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return Response.json({ error: 'Permission denied', reason: 'os-permission' }, { status: 403 });
  }
  if (code === 'ENOENT') {
    return Response.json({ error: 'Directory not found', reason: 'not-found' }, { status: 404 });
  }
  return Response.json({ error: 'fs operation failed' }, { status: 500 });
}

function contentConflict(safety: 'changed' | 'unknown'): Response {
  return Response.json({
    error: safety === 'changed' ? 'File changed since it was opened' : 'File could not be verified before saving',
    reason: 'content-conflict', safety,
  }, { status: 409 });
}

export function registerFsWriteRoutes(app: Hono): void {
  app.post('/api/fs/mkdir', (c) => mkdirHandler(c));
  app.post('/api/fs/write', (c) => writeHandler(c));
  app.post('/api/fs/delete', (c) => deleteHandler(c));
  app.post('/api/fs/rename', (c) => renameHandler(c));
}

async function mkdirHandler(c: Context): Promise<Response> {
  const body = await pickBody<PathBody>(c);
  if (!body?.path) return Response.json({ error: 'path is required' }, { status: 400 });
  if (body.allowOutsideWorkspace) {
    // §5.14: mkdir/write-family CANNOT get outside-workspace grants (403)
    return Response.json({ error: 'Outside workspace directory creation requires a grant' }, { status: 403 });
  }
  const context = requireContext(c);
  if (!context.ok) return context.response;
  const target = resolveWithin(context.scopeDir, body.path);
  if (!target) return denied();
  if (!containedReal(context.scopeDir, dirname(target))) return denied();
  try {
    mkdirSync(target, { recursive: true });
    return Response.json({ success: true, path: target });
  } catch (error) {
    return fsFailed(error);
  }
}

async function writeHandler(c: Context): Promise<Response> {
  const body = await pickBody<ContentBody>(c);
  if (!body?.path || typeof body.content !== 'string') {
    return Response.json({ error: 'path and content are required' }, { status: 400 });
  }
  if (body.content.length > WRITE_MAX_BYTES) {
    return Response.json({ error: `Content exceeds maximum size of ${WRITE_MAX_BYTES} bytes` }, { status: 413 });
  }
  if (body.expectedContent !== undefined && (typeof body.expectedContent !== 'string' || body.expectedContent.length > WRITE_MAX_BYTES)) {
    return Response.json({ error: 'Invalid expected content' }, { status: 400 });
  }
  const context = requireContext(c);
  if (!context.ok) return context.response;
  const target = resolveWithin(context.scopeDir, body.path);
  if (!target) return denied();
  if (!containedReal(context.scopeDir, dirname(target))) return denied();
  try {
    if (existsSync(target) && statSync(target).isDirectory()) {
      return body.expectedContent === undefined
        ? Response.json({ error: 'Path is a directory' }, { status: 400 }) : contentConflict('changed');
    }
  } catch (error) {
    return body.expectedContent === undefined ? fsFailed(error) : contentConflict('unknown');
  }
  if (body.expectedContent === undefined && isContentNoOp(target, body.content)) {
    return Response.json({ success: true, path: target, unchanged: true });
  }
  let tmp: string | null = null;
  try {
    await mkdir(resolve(target, '..'), { recursive: true });
    // Compare after the only async gap. The compare and rename are synchronous
    // in this server process, so competing NND writes cannot slip between them.
    const tmpPath = `${target}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await open(tmpPath, 'wx');
    tmp = tmpPath;
    try { await handle.writeFile(body.content, 'utf8'); }
    finally { await handle.close(); }
    if (body.expectedContent !== undefined) {
      let actual: Buffer;
      try {
        if (!statSync(target).isFile()) return contentConflict('changed');
        actual = readFileSync(target);
      } catch (error) {
        const code = (error as { code?: string }).code;
        return contentConflict(code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' ? 'changed' : 'unknown');
      }
      if (!actual.equals(Buffer.from(body.expectedContent, 'utf8'))) return contentConflict('changed');
      if (isContentNoOp(target, body.content)) {
        return Response.json({ success: true, path: target, unchanged: true });
      }
    }
    renameSync(tmp, target);
    tmp = null;
    return Response.json({ success: true, path: target });
  } catch (error) {
    return fsFailed(error);
  } finally {
    if (tmp !== null) { try { rmSync(tmp, { force: true }); } catch { /* preserve primary result */ } }
  }
}

async function deleteHandler(c: Context): Promise<Response> {
  const body = await pickBody<PathBody>(c);
  if (!body?.path) return Response.json({ error: 'path is required' }, { status: 400 });
  const context = requireContext(c);
  if (!context.ok) return context.response;
  const target = resolveWithin(context.scopeDir, body.path);
  if (!target) return denied();
  if (!existsSync(target)) return Response.json({ error: 'Path not found' }, { status: 404 });
  if (!containedReal(context.scopeDir, target)) return denied();
  if (target === resolve(context.scopeDir)) {
    return Response.json({ error: 'Refusing to delete the workspace root' }, { status: 400 });
  }
  try {
    rmSync(target, { recursive: true, force: true });
    return Response.json({ success: true, path: target });
  } catch (error) {
    return fsFailed(error);
  }
}

async function renameHandler(c: Context): Promise<Response> {
  const body = await pickBody<RenameBody>(c);
  if (!body?.oldPath || !body?.newPath) return Response.json({ error: 'oldPath and newPath are required' }, { status: 400 });
  const context = requireContext(c);
  if (!context.ok) return context.response;
  const from = resolveWithin(context.scopeDir, body.oldPath);
  const to = resolveWithin(context.scopeDir, body.newPath);
  if (!from || !to) return denied();
  if (!existsSync(from)) return Response.json({ error: 'Source not found' }, { status: 404 });
  // §5.14: both paths share one workspace base BY CONSTRUCTION — containment
  // already bounds them to the single ?directory scope.
  if (!containedReal(context.scopeDir, from) || !containedReal(context.scopeDir, to)) return denied();
  if (existsSync(to)) return Response.json({ error: 'Target already exists' }, { status: 409 });
  try {
    renameSync(from, to);
    return Response.json({ success: true, path: to });
  } catch (error) {
    return fsFailed(error);
  }
}
