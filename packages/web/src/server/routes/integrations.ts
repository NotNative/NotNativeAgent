// SPDX-License-Identifier: Apache-2.0
/**
 * W-53 integration surfaces: read-only GitHub PR list + Linear issue list.
 * Account setup is optional — fail-closed typed errors, never empty-list
 * lies. The server proxies the public APIs from the same host; the
 * directory parameter follows the git-walkthrough route's trust shape.
 */
import { execFileSync } from 'node:child_process';
import { Hono } from 'hono';
import { IntegrationError, listLinearIssues, listOpenPullRequests, parseRemoteOrigin } from '../lib/integrations/connectors.ts';

const TIMEOUT_MS = 10_000;

function remoteOrigin(directory: string): { owner: string; repo: string } | null {
  try {
    const url = execFileSync('git', ['-C', directory, 'remote', 'get-url', 'origin'], { timeout: TIMEOUT_MS, encoding: 'utf8' }).trim();
    return parseRemoteOrigin(url);
  } catch { return null; }
}

export function registerIntegrationRoutes(app: Hono): void {
  app.get('/api/integrations/github/pulls', (c) => {
    const directory = c.req.query('directory') ?? '';
    if (!directory) return c.json({ error: 'directory parameter is required', code: 'no-directory' }, 400);
    return (async () => {
      try {
        const pulls = await listOpenPullRequests({ origin: remoteOrigin(directory), token: process.env.GITHUB_TOKEN ?? null });
        return c.json({ pulls });
      } catch (cause) {
        if (cause instanceof IntegrationError) return c.json({ error: cause.message, code: cause.code }, cause.code === 'github-rate-limited' ? 429 : 409);
        return c.json({ error: 'GitHub integration failed.', code: 'github-unavailable' }, 500);
      }
    })();
  });

  app.get('/api/integrations/linear/issues', (c) => {
    return (async () => {
      try {
        const issues = await listLinearIssues({ apiKey: process.env.LINEAR_API_KEY ?? null });
        return c.json({ issues });
      } catch (cause) {
        if (cause instanceof IntegrationError) return c.json({ error: cause.message, code: cause.code }, 409);
        return c.json({ error: 'Linear integration failed.', code: 'linear-unavailable' }, 500);
      }
    })();
  });
}
