// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal static serving of the built UI (packages/web/dist). Dev mode never
 * uses this — Vite proxies /auth,/health,/api to this server instead.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

export function createStaticHandler(distDir: string) {
  return async (request: Request): Promise<Response | null> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;
    const url = new URL(request.url);
    let rel = decodeURIComponentSafe(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const abs = path.resolve(distDir, `.${rel}`);
    if (!abs.startsWith(path.resolve(distDir))) return null; // traversal guard
    try {
      const info = await stat(abs);
      if (info.isDirectory()) {
        if (!rel.endsWith('/')) return Response.redirect(`${url.pathname}/`, 301);
        return await serveFile(path.join(abs, 'index.html'));
      }
      return await serveFile(abs);
    } catch {
      // SPA fallback: unknown GET without a file extension → index.html
      if (!path.extname(rel)) {
        try {
          return await serveFile(path.join(distDir, 'index.html'));
        } catch {}
      }
      return null;
    }
  };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function serveFile(abs: string): Promise<Response> {
  const body = await readFile(abs);
  const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
  return new Response(body, {
    headers: { 'content-type': type, 'cache-control': 'no-cache' },
  });
}

/** UI dist root. NOTNATIVE_DIST_DIR wins (the P12 desktop shell points the
 * in-process server at resources/web-dist); the default stays the web
 * package's own dist build. */
const DIST_DIR_OVERRIDE = process.env.NOTNATIVE_DIST_DIR?.trim();
export const DIST_DIR = DIST_DIR_OVERRIDE
  ? path.resolve(DIST_DIR_OVERRIDE)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist');
