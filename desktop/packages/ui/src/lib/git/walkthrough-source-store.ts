// SPDX-License-Identifier: Apache-2.0
/** Current source selection and stable cache identity (doc 13 §F.1). */
import type { WalkthroughSource } from './walkthrough-preview.ts';

const FULL_OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;
const OWNER = /^[a-zA-Z0-9-]+$/u;
const REPOSITORY = /^[a-zA-Z0-9_.-]+$/u;

export function workingSource(scope: 'all' | 'staged' | 'working'): WalkthroughSource {
  return { kind: 'working-tree', scope };
}

export function branchSource(baseRef: string, headRef: string): WalkthroughSource | null {
  const base = baseRef.trim();
  const head = headRef.trim();
  if (!base || !head || base.length > 256 || head.length > 256) return null;
  return { kind: 'branch', baseRef: base, headRef: head };
}

export function commitSource(hash: string): WalkthroughSource | null {
  const value = hash.trim().toLowerCase();
  if (!FULL_OBJECT_ID.test(value)) return null;
  return { kind: 'commit', hash: value };
}

export function pullRequestSource(number: number, owner = '', repo = ''): WalkthroughSource | null {
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) return null;
  if (!owner && !repo) return { kind: 'pr', number };
  if (!OWNER.test(owner.trim()) || !REPOSITORY.test(repo.trim())) return null;
  return { kind: 'pr', number, sourceRepo: { owner: owner.trim(), repo: repo.trim() } };
}

export function sourceKey(source: WalkthroughSource): string {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  if (source.kind === 'commit') return `commit:${source.hash}`;
  return source.sourceRepo ? `pr:${source.sourceRepo.owner}/${source.sourceRepo.repo}:${source.number}` : `pr:${source.number}`;
}

export function sourceLabel(source: WalkthroughSource): string {
  if (source.kind === 'working-tree') {
    if (source.scope === 'all') return 'All uncommitted';
    if (source.scope === 'staged') return 'Staged';
    return 'Unstaged';
  }
  if (source.kind === 'branch') return `Branch ${source.baseRef}…${source.headRef}`;
  if (source.kind === 'commit') return `Commit ${source.hash.slice(0, 12)}`;
  return `Pull request ${source.number}`;
}
