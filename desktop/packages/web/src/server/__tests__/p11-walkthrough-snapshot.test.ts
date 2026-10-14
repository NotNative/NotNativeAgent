// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWalkthroughSnapshot, __snapshotTestables, SNAPSHOT_MAX_FILES } from '../routes/git-walkthrough-snapshot.ts';
import { buildWalkthroughTemplate, copyWalkthroughRepo, git as gitIn } from './helpers/git-fixture-kit.ts';

// Template repo built once per file; each test gets an isolated copy.
const template = buildWalkthroughTemplate();
let repo = '';
const git = (...args: string[]): string => gitIn(repo, ...args);
beforeEach(() => {
  repo = copyWalkthroughRepo(template);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('server-owned walkthrough snapshot', () => {
  it('separates staged, working, renamed, binary and untracked entries with stable content IDs', () => {
    writeFileSync(join(repo, 'both.txt'), 'staged\n'); git('add', 'both.txt');
    writeFileSync(join(repo, 'both.txt'), 'working\n');
    git('mv', 'rename.txt', 'renamed.txt');
    writeFileSync(join(repo, 'renamed.txt'), 'rename new\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    const first = getWalkthroughSnapshot(repo);
    const second = getWalkthroughSnapshot(repo);
    expect(first).toEqual(second);
    expect(first.stops.map((stop) => `${stop.scope}:${stop.path}`)).toEqual(expect.arrayContaining([
      'staged:both.txt', 'working:both.txt', 'working:new.txt', 'working:renamed.txt',
    ]));
    expect(first.stops.find((stop) => stop.path === 'renamed.txt')?.oldPath).toBe('rename.txt');
    expect(first.stops.find((stop) => stop.path === 'both.txt' && stop.scope === 'staged')?.id)
      .not.toBe(first.stops.find((stop) => stop.path === 'both.txt' && stop.scope === 'working')?.id);
    expect(first.binaryFiles).toBe(1);
    writeFileSync(join(repo, 'both.txt'), 'working changed\n');
    expect(getWalkthroughSnapshot(repo).signature).not.toBe(first.signature);
  }, 15_000);

  it('returns a retryable stale failure rather than a mixed capture on concurrent edit', () => {
    writeFileSync(join(repo, 'both.txt'), 'before\n');
    expect(() => getWalkthroughSnapshot(repo, () => writeFileSync(join(repo, 'both.txt'), 'after\n')))
      .toThrow(/Changes moved.*Retry/u);
  });

  it('limits the snapshot to the selected staged or working scope', () => {
    writeFileSync(join(repo, 'both.txt'), 'staged\n'); git('add', 'both.txt');
    writeFileSync(join(repo, 'both.txt'), 'working\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const staged = getWalkthroughSnapshot(repo, undefined, 'staged');
    const working = getWalkthroughSnapshot(repo, undefined, 'working');
    expect(staged.stops.every((item) => item.scope === 'staged')).toBe(true);
    expect(working.stops.every((item) => item.scope === 'working')).toBe(true);
    expect(staged.stops.map((item) => item.path)).not.toContain('new.txt');
    expect(working.stops.map((item) => item.path)).toContain('new.txt');
    expect(staged.signature).not.toBe(working.signature);
    expect(() => getWalkthroughSnapshot(repo, undefined, 'else' as 'all')).toThrow(/Invalid walkthrough scope/u);
  });

  it('keeps scoped revision stable when only the other side changes, including a mixed-status file', () => {
    writeFileSync(join(repo, 'both.txt'), 'staged\n'); git('add', 'both.txt');
    const staged = getWalkthroughSnapshot(repo, undefined, 'staged');
    writeFileSync(join(repo, 'both.txt'), 'working one\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    expect(getWalkthroughSnapshot(repo, undefined, 'staged').signature).toBe(staged.signature);
    const working = getWalkthroughSnapshot(repo, undefined, 'working');
    writeFileSync(join(repo, 'rename.txt'), 'new staged\n'); git('add', 'rename.txt');
    expect(getWalkthroughSnapshot(repo, undefined, 'working').signature).toBe(working.signature);
    writeFileSync(join(repo, 'both.txt'), 'working two\n');
    expect(getWalkthroughSnapshot(repo, undefined, 'working').signature).not.toBe(working.signature);
  });

  it('keeps the staged anchor when a separately modified file is renamed only in the worktree', () => {
    writeFileSync(join(repo, 'both.txt'), 'staged\n'); git('add', 'both.txt');
    renameSync(join(repo, 'both.txt'), join(repo, 'worktree-name.txt'));
    const staged = getWalkthroughSnapshot(repo, undefined, 'staged');
    expect(staged.stops.map((item) => item.path)).toEqual(['both.txt']);
  });

  it('keeps deleted tracked paths and absent rename sources in the tour', () => {
    git('rm', '-q', 'both.txt');
    git('mv', 'rename.txt', 'renamed.txt');
    writeFileSync(join(repo, 'renamed.txt'), 'renamed content\n');
    git('add', 'renamed.txt');
    const snapshot = getWalkthroughSnapshot(repo);
    expect(snapshot.stops.map((stop) => `${stop.scope}:${stop.path}`)).toEqual(expect.arrayContaining([
      'staged:both.txt', 'staged:renamed.txt',
    ]));
  });

  it('does not follow a final symlink but rejects a symlinked parent that escapes', () => {
    const outside = mkdtempSync(join(tmpdir(), 'nnd-walkthrough-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'private\n');
      symlinkSync(outside, join(repo, 'outside-link'), 'junction');
      expect(__snapshotTestables.safePath(repo, repo, 'outside-link')).toBe(true);
      expect(__snapshotTestables.safePath(repo, repo, 'outside-link/secret.txt')).toBe(false);
    } finally {
      rmSync(join(repo, 'outside-link'), { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('limits file scopes and preserves nested workspace containment', () => {
    const nested = join(repo, 'nested'); mkdirSync(nested);
    writeFileSync(join(nested, 'new.txt'), 'inside\n');
    writeFileSync(join(repo, 'outside.txt'), 'outside\n');
    const scoped = getWalkthroughSnapshot(nested);
    expect(scoped.stops.map((stop) => stop.path)).toEqual(['nested/new.txt']);
    for (let i = 0; i <= SNAPSHOT_MAX_FILES; i += 1) writeFileSync(join(nested, `item-${i}.txt`), 'x\n');
    expect(() => getWalkthroughSnapshot(nested)).toThrow(/at most/u);
  });

  it('treats a nested workspace path as a literal Git pathspec', () => {
    const nested = join(repo, 'bracket[dir]'); mkdirSync(nested);
    writeFileSync(join(nested, 'inside.txt'), 'inside\n');
    mkdirSync(join(repo, 'bracketd'));
    writeFileSync(join(repo, 'bracketd', 'outside.txt'), 'outside\n');
    expect(getWalkthroughSnapshot(nested).stops.map((stop) => stop.path)).toEqual(['bracket[dir]/inside.txt']);
  });

  it('rejects aggregate patch bytes even when each file is under its individual cap', () => {
    writeFileSync(join(repo, 'large-a.txt'), `${'a'.repeat(400_000)}\n`);
    writeFileSync(join(repo, 'large-b.txt'), `${'b'.repeat(400_000)}\n`);
    expect(() => getWalkthroughSnapshot(repo)).toThrow(/Diff exceeds walkthrough preview limit/u);
  });

  it('suffixes repeated equal hunk IDs without making the first ID positional', () => {
    const part = { scope: 'working' as const, path: 'a.txt', patch: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-a\n+b\n' };
    const result = __snapshotTestables.stopsFrom([part]);
    expect(result.stops[1]?.id).toBe(`${result.stops[0]?.id}-2`);
  });

  it('works before the first commit and changes revision proof on branch switch', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'nnd-unborn-'));
    try {
      execFileSync('git', ['init', '-q', fresh]);
      writeFileSync(join(fresh, 'first.txt'), 'first\n');
      const initial = getWalkthroughSnapshot(fresh);
      expect(initial.stops[0]?.path).toBe('first.txt');
      execFileSync('git', ['-C', fresh, 'symbolic-ref', 'HEAD', 'refs/heads/other']);
      expect(getWalkthroughSnapshot(fresh).signature).not.toBe(initial.signature);
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  });
});
