// SPDX-License-Identifier: Apache-2.0
/**
 * P6-1 file-content routes (doc 03 §5.14 subset, read family): stat / read
 * (text/plain + the 3-retry empty-read guard for the concurrent-write
 * O_TRUNC window) / raw (binary asset with per-extension MIME, optional
 * download disposition, no-store + nosniff). ALL routes are WORKSPACE-BOUND
 * through the P4-1 containment helpers (?directory scope required; the
 * doc's allowOutsideWorkspace grant param is a desktop-runtime concept that
 * this web build does not issue — rejected outright, delta E-06-1).
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, sep } from 'node:path';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Hono } from 'hono';
import { resolveWithin, realpath } from './fs.ts';
import { resolveOutsideFileGrant } from '../lib/fs/outside-file-grants.ts';
import { isImageSignature } from '../lib/markdown-image-grants/image-file-resolver.ts';

const RAW_MAX_BYTES = 50 * 1024 * 1024;
const GRANT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const EMPTY_READ_RETRIES = [50, 100, 150];

const RAW_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

export function registerFsReadRoutes(app: Hono): void {
  app.get('/api/fs/stat', (c) => statRoute(c.req.query()));
  app.get('/api/fs/read', (c) => readRoute(c));
  app.get('/api/fs/raw', (c) => rawRoute(c.req.query()));
}

interface ReadQuery { path?: string; directory?: string; optional?: string; download?: string }
interface RawQuery extends ReadQuery { allowOutsideWorkspace?: string; outsideFileGrant?: string; grantExpiresAt?: number }

function denied(): Response {
  return Response.json({ error: 'Access denied' }, { status: 403 });
}

function notFound(): Response {
  return Response.json({ error: 'File not found', reason: 'not-found' }, { status: 404 });
}

function resolveTarget(query: ReadQuery): { target: string; stat: import('node:fs').Stats } | Response {
  const { path, directory } = query;
  if (!path || !directory) return Response.json({ error: 'path and directory are required' }, { status: 400 });
  const within = resolveWithin(directory, path);
  if (!within) return denied();
  const scopeReal = realpath(directory);
  const target = realpath(within);
  if (resolveWithin(scopeReal, target) === null) return denied();
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) return notFound();
  return { target, stat };
}

function resolveRawTarget(query: RawQuery): { target: string; stat: import('node:fs').Stats; grantExpiresAt?: number } | Response {
  if (query.path && query.allowOutsideWorkspace === 'true') {
    try {
      const target = resolve(query.path);
      const realTarget = realpathSync(target);
      const grant = resolveOutsideFileGrant(query.outsideFileGrant, realTarget);
      if (grant === null) return denied();
      const stat = statSync(realTarget, { throwIfNoEntry: false });
      if (!stat) return notFound();
      return { target: realTarget, stat, grantExpiresAt: grant.expiresAt };
    } catch {
      return denied();
    }
  }
  return resolveTarget(query);
}

function statRoute(query: ReadQuery): Response {
  const resolved = resolveTarget(query);
  if (resolved instanceof Response) {
    if (query.optional === 'true' && isNotFound(resolved)) {
      return Response.json({ path: query.path ?? '', exists: false });
    }
    return resolved;
  }
  const { target, stat } = resolved;
  return Response.json({ path: target, isFile: stat.isFile(), exists: true, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
}

async function readRoute(context: { req: { query: () => ReadQuery } }): Promise<Response> {
  const query = context.req.query();
  const resolved = resolveTarget(query);
  if (resolved instanceof Response) {
    if (query.optional === 'true' && isNotFound(resolved)) return new Response('', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return resolved;
  }
  const { stat, target } = resolved;
  if (!stat.isFile()) return Response.json({ error: 'Not a file', reason: 'not-file' }, { status: 400 });
  // §5.14 empty-read retry: stat saw 0 bytes but read emptied under a
  // concurrent write; ASYNC waits (never a synchronous event-loop spin).
  let content: Buffer | null = null;
  for (let attempt = 0; attempt <= EMPTY_READ_RETRIES.length; attempt += 1) {
    try {
      content = readFileSync(target);
    } catch (error) {
      return fsFailure(error);
    }
    if (content.length > 0 || stat.size === 0) break;
    if (attempt < EMPTY_READ_RETRIES.length) await new Promise((done) => setTimeout(done, EMPTY_READ_RETRIES[attempt]));
  }
  return new Response(content!.toString('utf8'), {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function rawRoute(query: RawQuery): Response {
  const resolved = resolveRawTarget(query);
  if (resolved instanceof Response) return resolved;
  const { stat, target } = resolved;
  if (!stat.isFile()) return Response.json({ error: 'Not a file', reason: 'not-file' }, { status: 400 });
  if (resolved.grantExpiresAt !== undefined && stat.size > GRANT_IMAGE_MAX_BYTES) {
    return Response.json({ error: 'File too large to serve' }, { status: 413 });
  }
  if (stat.size > RAW_MAX_BYTES) return Response.json({ error: 'File too large to serve' }, { status: 413 });
  let content: Buffer;
  try {
    content = readFileSync(target);
  } catch (error) {
    return fsFailure(error);
  }
  if (content.length > RAW_MAX_BYTES) return Response.json({ error: 'File too large to serve' }, { status: 413 });
  if (resolved.grantExpiresAt !== undefined && content.length > GRANT_IMAGE_MAX_BYTES) {
    return Response.json({ error: 'File too large to serve' }, { status: 413 });
  }
  if (resolved.grantExpiresAt !== undefined && !isImageSignature(content.subarray(0, Math.min(12, content.length)))) {
    return Response.json({ error: 'Not a prepared image' }, { status: 415 });
  }
  const mime = RAW_MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': mime,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (query.download === 'true') {
    const name = target.split(sep).pop() ?? 'file';
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  return new Response(new Uint8Array(content), { status: 200, headers });
}

function isNotFound(response: Response): boolean {
  return response.status === 404;
}

function fsFailure(error: unknown): Response {
  const code = (error as { code?: string }).code;
  if (code === 'EACCES' || code === 'EPERM') return Response.json({ error: 'Permission denied', reason: 'os-permission' }, { status: 403 });
  if (code === 'ENOENT') return notFound();
  if (code === 'EISDIR') return Response.json({ error: 'Not a file', reason: 'not-file' }, { status: 400 });
  return Response.json({ error: 'fs operation failed' }, { status: 500 });
}
