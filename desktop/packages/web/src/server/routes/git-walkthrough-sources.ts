// SPDX-License-Identifier: Apache-2.0
/**
 * Walkthrough source admission and stable source identity (doc 13 E2D0A7).
 * Git-backed sources produce stable object-id/patch-revision snapshots. PR
 * descriptors are accepted for supported UI selection, but currently fail
 * closed when GitHub transport is unavailable.
 */
export const OWNER = /^[a-zA-Z0-9-]+$/u;
export const REPOSITORY = /^[a-zA-Z0-9_.-]+$/u;
const FULL_OBJECT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;
const MAX_INPUT_CHARS = 256;

export type WalkthroughScope = 'all' | 'staged' | 'working';
export type WalkthroughSource =
  | { kind: 'working-tree'; scope: WalkthroughScope }
  | { kind: 'branch'; baseRef: string; headRef: string }
  | { kind: 'commit'; hash: string }
  | { kind: 'pr'; number: number; sourceRepo?: { owner: string; repo: string } };



export function sourceKey(source: WalkthroughSource): string {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  if (source.kind === 'commit') return `commit:${source.hash}`;
  return source.sourceRepo ? `pr:${source.sourceRepo.owner}/${source.sourceRepo.repo}:${source.number}` : `pr:${source.number}`;
}

function boundedString(value: unknown, maxBytes = MAX_INPUT_CHARS): string | null {
  return typeof value === 'string' && value.length <= maxBytes && Buffer.byteLength(value, 'utf8') <= maxBytes ? value : null;
}

export function parseWalkthroughSource(raw: unknown): WalkthroughSource {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return { kind: 'working-tree', scope: 'all' };
  if (raw === 'staged' || raw === 'working') return { kind: 'working-tree', scope: raw };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('Invalid walkthrough source.'), { status: 400, code: 'nnd_walkthrough_source_invalid' });
  const value = raw as Record<string, unknown>;
  if (value.kind === 'working-tree') {
    const scope = value.scope ?? 'all';
    if (scope !== 'all' && scope !== 'staged' && scope !== 'working') throw Object.assign(new Error('Invalid walkthrough scope.'), { status: 400, code: 'nnd_walkthrough_scope_invalid' });
    return { kind: 'working-tree', scope };
  }
  if (value.kind === 'branch') {
    const baseRef = boundedString(value.baseRef)?.trim();
    const headRef = boundedString(value.headRef)?.trim();
    if (!baseRef || !headRef) throw Object.assign(new Error('Branch comparison requires base and head refs.'), { status: 400, code: 'nnd_walkthrough_source_invalid' });
    return { kind: 'branch', baseRef, headRef };
  }
  if (value.kind === 'commit') {
    const hash = boundedString(value.hash)?.trim().toLowerCase();
    if (!hash || !FULL_OBJECT.test(hash)) throw Object.assign(new Error('Commit walkthrough requires a full object id.'), { status: 400, code: 'nnd_walkthrough_source_invalid' });
    return { kind: 'commit', hash };
  }
  if (value.kind === 'pr') {
    const number = value.number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
      throw Object.assign(new Error('Invalid pull request number.'), { status: 400, code: 'nnd_walkthrough_source_invalid' });
    }
    if (value.sourceRepo === undefined || value.sourceRepo === null) return { kind: 'pr', number };
    const repository = value.sourceRepo as Record<string, unknown>;
    const owner = typeof repository.owner === 'string' ? repository.owner.trim() : '';
    const repo = typeof repository.repo === 'string' ? repository.repo.trim() : '';
    if (!OWNER.test(owner) || !REPOSITORY.test(repo)) throw Object.assign(new Error('Invalid pull request repository.'), { status: 400, code: 'nnd_walkthrough_source_invalid' });
    return { kind: 'pr', number, sourceRepo: { owner, repo } };
  }
  throw Object.assign(new Error('Unsupported walkthrough source.'), { status: 400, code: 'nnd_walkthrough_source_invalid' });
}


