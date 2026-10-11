// SPDX-License-Identifier: Apache-2.0
/** W-53 connectors: parse/normalize + fail-closed typed errors, fake fetch. */
import { describe, expect, it } from 'vitest';
import { IntegrationError, listLinearIssues, listOpenPullRequests, parseRemoteOrigin } from '../lib/integrations/connectors.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('integration connectors (W-53)', () => {
  it('parses ssh and https remote origins', () => {
    expect(parseRemoteOrigin('git@github.com:acme/widget.git')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseRemoteOrigin('https://github.com/acme/widget.git')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseRemoteOrigin('https://gitlab.com/acme/widget/')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseRemoteOrigin('not-a-remote')).toBeNull();
    expect(parseRemoteOrigin(null)).toBeNull();
  });

  it('lists open pulls, normalizes drafts, drops malformed entries, and passes an optional token', async () => {
    const seen: string[] = [];
    const pulls = await listOpenPullRequests({
      origin: { owner: 'acme', repo: 'widget' },
      token: 'tok-1',
      fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push(`${url} ${init?.headers ? JSON.stringify((init.headers as Record<string, string>).Authorization ?? '') : ''}`);
        return jsonResponse([
          { number: 7, title: 'Fix leak', draft: true, html_url: 'https://github.com/acme/widget/pull/7', updated_at: '2026-01-02T00:00:00Z', head: { ref: 'fix' }, base: { ref: 'main' } },
          { number: 8, title: 'Add tests', html_url: 'https://github.com/acme/widget/pull/8', updated_at: '2026-01-03T00:00:00Z', head: { ref: 't' }, base: { ref: 'main' } },
          { number: 'bogus', title: 9 },
        ]);
      }) as typeof fetch,
    });
    expect(seen[0]).toContain('/repos/acme/widget/pulls');
    expect(seen[0]).toContain('Bearer tok-1');
    expect(pulls).toHaveLength(2);
    expect(pulls[0]).toMatchObject({ number: 7, state: 'draft', headRef: 'fix' });
    expect(pulls[1]!.state).toBe('open');
  });

  it('fails closed: no remote, transport error, rate limit, malformed payloads', async () => {
    await expect(listOpenPullRequests({ origin: null, fetchImpl: (async () => jsonResponse([])) as typeof fetch }))
      .rejects.toMatchObject({ code: 'no-remote' });
    await expect(listOpenPullRequests({ origin: { owner: 'a', repo: 'b' }, fetchImpl: (async () => { throw new TypeError('down'); }) as typeof fetch }))
      .rejects.toMatchObject({ code: 'github-unavailable' });
    await expect(listOpenPullRequests({ origin: { owner: 'a', repo: 'b' }, fetchImpl: (async () => jsonResponse({ message: 'rate limited' }, 403)) as typeof fetch }))
      .rejects.toMatchObject({ code: 'github-rate-limited' });
    await expect(listOpenPullRequests({ origin: { owner: 'a', repo: 'b' }, fetchImpl: (async () => jsonResponse({ nope: true })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'github-unavailable' });
    await expect(listOpenPullRequests({ origin: { owner: 'a', repo: 'b' }, fetchImpl: (async () => new Response('not json', { status: 200 })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'github-unavailable' });
    expect(new IntegrationError('no-remote', 'x')).toBeInstanceOf(Error);
  });

  it('linear fails closed unconfigured and parses issues when keyed', async () => {
    await expect(listLinearIssues({ apiKey: null, fetchImpl: (async () => jsonResponse({})) as typeof fetch }))
      .rejects.toMatchObject({ code: 'linear-unconfigured' });
    const seen: RequestInit[] = [];
    const issues = await listLinearIssues({
      apiKey: 'lin_key',
      fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push(init ?? {});
        return jsonResponse({ data: { issues: { nodes: [
          { id: 'i-1', identifier: 'AC-1', title: 'Ship it', state: { name: 'In Progress' }, assignee: { name: 'Ada' }, url: 'https://linear.app/ac/issue/AC-1', updatedAt: '2026-01-04T00:00:00Z' },
          { id: 'i-2', identifier: 'AC-2', title: 'Unassigned', state: { name: 'Todo' }, assignee: null, url: 'https://linear.app/ac/issue/AC-2', updatedAt: '2026-01-05T00:00:00Z' },
        ] } } });
      }) as typeof fetch,
    });
    expect((seen[0]!.headers as Record<string, string>).Authorization).toBe('lin_key');
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ identifier: 'AC-1', state: 'In Progress', assignee: 'Ada' });
    expect(issues[1]!.assignee).toBeNull();
    await expect(listLinearIssues({ apiKey: 'lin_key', fetchImpl: (async () => jsonResponse({ data: {} })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'linear-unavailable' });
  });
});
