// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWalkthroughSnapshot } from '../routes/git-walkthrough-snapshot.ts';
import { parseWalkthroughSource, sourceKey, type WalkthroughSource } from '../routes/git-walkthrough-sources.ts';

let repo = '';
let commit = '';
let commitParent = '';
function expectSourceError(source: WalkthroughSource, code: string): void {
  try {
    getWalkthroughSnapshot(repo, undefined, source);
  } catch (cause) {
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected walkthrough snapshot to fail with ${code}.`);
}
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'nnd-walkthrough-source-'));
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'one.txt'), 'first\n');
  git('add', '-A'); git('commit', '-qm', 'first');
  commitParent = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(repo, 'one.txt'), 'second\n');
  writeFileSync(join(repo, 'two.txt'), 'second\n');
  git('add', '-A'); git('commit', '-qm', 'second');
  commit = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(repo, 'one.txt'), 'current\n');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('walkthrough source descriptors', () => {
  it('parses and keys all supported source kinds', () => {
    expect(parseWalkthroughSource('staged')).toEqual({ kind: 'working-tree', scope: 'staged' });
    expect(parseWalkthroughSource({ kind: 'branch', baseRef: 'feature', headRef: 'main' })).toEqual({ kind: 'branch', baseRef: 'feature', headRef: 'main' });
    expect(parseWalkthroughSource({ kind: 'commit', hash: commit.toUpperCase() })).toEqual({ kind: 'commit', hash: commit });
    const repository = { kind: 'pr', number : 24, sourceRepo: { owner: 'good-owner', repo: 'repo.name' } };
    expect(parseWalkthroughSource(repository)).toEqual(repository);
    expect(sourceKey({ kind: 'commit', hash: commit })).toBe(`commit:${commit}`);
    expect(() => parseWalkthroughSource({ kind: 'branch', baseRef: '', headRef: 'main' })).toThrow(/base and head/u);
    expect(() => parseWalkthroughSource({ kind: 'commit', hash: 'abc' })).toThrow(/full object id/u);
    expect(() => parseWalkthroughSource({ kind: 'pr', number: -1 })).toThrow(/pull request number/u);
    expect(() => parseWalkthroughSource({ kind: 'pr', number: 1, sourceRepo: { owner: 'bad!owner', repo: 'repo' } })).toThrow(/repository/u);
    expect(() => parseWalkthroughSource({ kind: 'unknown' })).toThrow(/Unsupported/u);
  });

  it('snapshots a full commit against its first parent', () => {
    const source: WalkthroughSource = { kind: 'commit', hash: commit };
    const first = getWalkthroughSnapshot(repo, undefined, source);
    const second = getWalkthroughSnapshot(repo, undefined, source);
    expect(first).toEqual(second);
    expect(first.source).toEqual(source);
    expect(first.stops.map((stop) => stop.path)).toContain('one.txt');
    expect(first.stops[0]?.scope).toBe('working');
    expect(first.signature).toMatch(/^commit:[0-9a-f]{40}:[0-9a-f]{40}$/u);
    expect(first.stops.some((stop) => stop.body.includes('second'))).toBe(true);
  });

  it('reviews a root commit against the empty tree', () => {
    const source: WalkthroughSource = { kind: 'commit', hash: commitParent };
    const snapshot = getWalkthroughSnapshot(repo, undefined, source);
    expect(snapshot.stops.some((stop) => stop.path === 'one.txt')).toBe(true);
    expect(snapshot.stops.some((stop) => stop.body.includes('first'))).toBe(true);
  });

  it('snapshots a three-dot branch comparison by its merge base and keeps working-tree changes separate', () => {
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'next']);
    writeFileSync(join(repo, 'committed.txt'), 'committed\n');
    execFileSync('git', ['-C', repo, 'add', 'committed.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'next']);
    const source: WalkthroughSource = { kind: 'branch', baseRef: 'master', headRef: 'next' };
    const branch = getWalkthroughSnapshot(repo, undefined, source);
    expect(branch.source).toEqual(source);
    expect(branch.stops.find((stop) => stop.path === 'committed.txt')).toBeDefined();
    expect(branch.stops.find((stop) => stop.path === 'one.txt')).toBeUndefined();
    const working = getWalkthroughSnapshot(repo, undefined, 'all');
    expect(working.stops.map((stop) => stop.path)).toContain('one.txt');
    expect(working.source).toBeUndefined();
    expect(branch.signature).not.toBe(working.signature);
  });

  it('rejects unknown objects and closed PR transport without pretending to encode', () => {
    expectSourceError({ kind: 'commit', hash: commitParent.replace(/[0-9]/g, '0') }, 'unknown-source');
    expectSourceError({ kind: 'pr', number: 42 }, 'github-not-connected');
  });
});
