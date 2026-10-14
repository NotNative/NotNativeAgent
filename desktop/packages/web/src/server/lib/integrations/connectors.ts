// SPDX-License-Identifier: Apache-2.0
/**
 * GitHub/Linear integration transports (W-53): read-only surfaces over the
 * public REST/GraphQL APIs. Account setup is optional — GitHub works
 * unauthenticated (rate-limited) and picks up an optional GITHUB_TOKEN;
 * Linear requires a LINEAR_API_KEY and fails closed with a typed
 * `linear-unconfigured` code until an operator supplies one. Every transport
 * failure is fail-closed with a typed code; no silent empty lists.
 * No paid services: both APIs are free tiers.
 */
const GITHUB_API = 'https://api.github.com';
const LINEAR_API = 'https://api.linear.app/graphql';
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 10_000;

export type PullRequestSummary = {
  number: number; title: string; state: 'open' | 'draft';
  headRef: string; baseRef: string; url: string; updatedAt: string;
};

export type LinearIssueSummary = {
  id: string; identifier: string; title: string; state: string;
  assignee: string | null; url: string; updatedAt: string;
};

export type RemoteOrigin = { owner: string; repo: string };

export class IntegrationError extends Error {
  constructor(readonly code: 'nnd_integration_github_unavailable' | 'nnd_integration_github_rate_limited' | 'nnd_integration_no_remote' | 'nnd_integration_linear_unconfigured' | 'nnd_integration_linear_unavailable', message: string) {
    super(message);
  }
}

export function parseRemoteOrigin(remoteUrl: string | null): RemoteOrigin | null {
  if (!remoteUrl) return null;
  const ssh = remoteUrl.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  const https = remoteUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/u);
  if (https) return { owner: https[1]!, repo: https[2]! };
  return null;
}

export async function listOpenPullRequests(input: {
  origin: RemoteOrigin | null;
  fetchImpl?: typeof fetch;
  token?: string | null;
  signal?: AbortSignal;
}): Promise<PullRequestSummary[]> {
  if (!input.origin) throw new IntegrationError('nnd_integration_no_remote', 'No GitHub remote origin for this directory.');
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/repos/${input.origin.owner}/${input.origin.repo}/pulls?state=open&per_page=30`, {
      headers, signal: AbortSignal.any([input.signal ?? AbortSignal.abort(), AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch {
    throw new IntegrationError('nnd_integration_github_unavailable', 'GitHub API transport failed.');
  }
  if (response.status === 403 || response.status === 429) throw new IntegrationError('nnd_integration_github_rate_limited', 'GitHub API rate limit reached.');
  if (!response.ok) throw new IntegrationError('nnd_integration_github_unavailable', `GitHub API returned ${response.status}.`);
  const text = await boundedText(response);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new IntegrationError('nnd_integration_github_unavailable', 'GitHub API returned malformed JSON.'); }
  if (!Array.isArray(raw)) throw new IntegrationError('nnd_integration_github_unavailable', 'GitHub API payload is not a pull list.');
  return raw.flatMap((entry): PullRequestSummary[] => {
    const pr = entry as Record<string, unknown>;
    if (typeof pr.number !== 'number' || typeof pr.title !== 'string' || typeof pr.html_url !== 'string'
      || typeof pr.updated_at !== 'string' || typeof (pr.head as Record<string, unknown>)?.ref !== 'string'
      || typeof (pr.base as Record<string, unknown>)?.ref !== 'string') return [];
    return [{
      number: pr.number, title: pr.title, state: pr.draft === true ? 'draft' : 'open',
      headRef: (pr.head as Record<string, unknown>).ref as string, baseRef: (pr.base as Record<string, unknown>).ref as string,
      url: pr.html_url, updatedAt: pr.updated_at,
    }];
  });
}

export async function listLinearIssues(input: {
  apiKey: string | null | undefined;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<LinearIssueSummary[]> {
  if (!input.apiKey) throw new IntegrationError('nnd_integration_linear_unconfigured', 'No Linear API key configured (setup is optional; the surface fails closed).');
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(LINEAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: input.apiKey },
      body: JSON.stringify({ query: `query { issues(first: 30, filter: { state: { type: { neq: "completed" } } }) { nodes { identifier title state { name } assignee { name } url updatedAt } } }` }),
      signal: AbortSignal.any([input.signal ?? AbortSignal.abort(), AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch {
    throw new IntegrationError('nnd_integration_linear_unavailable', 'Linear API transport failed.');
  }
  if (!response.ok) throw new IntegrationError('nnd_integration_linear_unavailable', `Linear API returned ${response.status}.`);
  const text = await boundedText(response);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new IntegrationError('nnd_integration_linear_unavailable', 'Linear API returned malformed JSON.'); }
  const nodes = (raw as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const list = (nodes?.issues as Record<string, unknown>)?.nodes;
  if (!Array.isArray(list)) throw new IntegrationError('nnd_integration_linear_unavailable', 'Linear API payload is not an issue list.');
  return list.flatMap((entry): LinearIssueSummary[] => {
    const issue = entry as Record<string, unknown>;
    if (typeof issue.identifier !== 'string' || typeof issue.title !== 'string' || typeof issue.url !== 'string'
      || typeof issue.updatedAt !== 'string' || typeof (issue.state as Record<string, unknown>)?.name !== 'string') return [];
    const assignee = issue.assignee as Record<string, unknown> | null;
    return [{
      id: String(issue.id ?? issue.identifier), identifier: issue.identifier, title: issue.title,
      state: (issue.state as Record<string, unknown>).name as string,
      assignee: assignee && typeof assignee.name === 'string' ? assignee.name : null,
      url: issue.url, updatedAt: issue.updatedAt,
    }];
  });
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new IntegrationError('nnd_integration_github_unavailable', 'Empty response body.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new IntegrationError('nnd_integration_github_unavailable', 'Response body exceeds the size bound.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}
