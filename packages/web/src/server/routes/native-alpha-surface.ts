// SPDX-License-Identifier: Apache-2.0
/** NND-owned mutations without a proven native reviewer contract stay closed in
 * the installed NNA service. NNA's harness proxy owns chat, setup, and review. */
import type { Context, Next } from 'hono';
import { nativeServiceTerminalUnavailable } from '../env.ts';

const CLOSED_FAMILIES = [
  '/api/fs', '/api/git', '/api/message-queue', '/api/goals',
  '/api/session-knowledge', '/api/agent-memory', '/api/session-folders',
  '/api/session-org', '/api/sessions', '/api/project-context', '/api/openchamber', '/api/magic-prompts',
  '/api/small-model', '/api/push', '/api/client-auth',
  '/api/config/skills', '/api/config/mcp', '/api/config/snippets',
  '/api/notnative/settings', '/api/config/settings', '/api/config/reload',
  '/api/notnative/update-install',
  '/api/openchamber/update-install',
  '/api/agent-tool',
  '/api/system/probe-url', '/api/browser-control',
] as const;

function inFamily(path: string, family: string): boolean {
  return path === family || path.startsWith(`${family}/`);
}

export function nativeAlphaMutationUnavailable(method: string, path: string): boolean {
  if (!nativeServiceTerminalUnavailable() || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false;
  if (CLOSED_FAMILIES.some(family => inFamily(path, family))) return true;
  return /^\/api\/projects\/[^/]+\/(?:config|scheduled-tasks)(?:\/|$)/u.test(path);
}

export async function nativeAlphaSurfaceGate(c: Context, next: Next): Promise<Response | void> {
  if (nativeAlphaMutationUnavailable(c.req.method, c.req.path)) {
    return nativeAlphaUnavailableResponse(c);
  }
  return next();
}

export function nativeAlphaUnavailableResponse(c: Context): Response {
  return c.json({ code: 'native_alpha_surface_unavailable',
    error: 'This action is unavailable in the installed native alpha until native review is verified.' },
  409, { 'cache-control': 'no-store' });
}
