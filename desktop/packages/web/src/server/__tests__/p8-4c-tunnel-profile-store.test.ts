// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4c gates part 2: the §4.4 managed-remote profile store — sanitizing
 * list/view resolution, upsert conflict removal (by id AND hostname) with
 * the promise-locked writer, preset sync, legacy migration from
 * cloudflare-named-tunnels.json, corruption refusal with explicit-heal
 * upsert, and token-free API views (§12.1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join as pathJoin, sep } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import {
  getManagedRemoteProfileStore, ManagedRemoteProfileStore,
  resetManagedRemoteProfileStoreForTests, MANAGED_REMOTE_STORE_FILE, LEGACY_NAMED_TUNNELS_FILE,
} from '../lib/tunnels/tunnel-profile-store.ts';

const ROOTS: string[] = [];

afterEach(() => {
  resetManagedRemoteProfileStoreForTests();
  while (ROOTS.length > 0) {
    const root = ROOTS.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(`${osTmpdir()}${sep}nnd-tunnel-store-`);
  ROOTS.push(dir);
  return dir;
}

describe('profile store §4.4', () => {
  it('empty store lists nothing and answers no tokens', () => {
    const store = new ManagedRemoteProfileStore(freshDir());
    expect(store.list()).toEqual([]);
    expect(store.view()).toEqual([]);
    expect(store.hasToken()).toBe(false);
    expect(store.resolveToken({ presetId: 'p1', hostname: 't.example.com' })).toBe('');
  });

  it('upsert appends, resolves by presetId first then hostname; ids and hostnames ride the API view', async () => {
    const store = new ManagedRemoteProfileStore(freshDir());
    await store.upsert({ id: 'alpha', name: 'Alpha', hostname: 'ALPHA.Example.COM', token: 'tok-alpha' });
    await store.upsert({ id: 'beta', name: 'Beta', hostname: 'beta.example.com', token: 'tok-beta' });
    expect(store.view()).toEqual([
      { id: 'alpha', name: 'Alpha', hostname: 'alpha.example.com' },
      { id: 'beta', name: 'Beta', hostname: 'beta.example.com' },
    ]);
    expect(store.hasToken()).toBe(true);
    expect(store.resolveToken({ presetId: 'beta' })).toBe('tok-beta');
    expect(store.resolveToken({ hostname: 'https://alpha.example.com/' })).toBe('tok-alpha');
    expect(store.resolveToken({ presetId: 'missing', hostname: 'beta.example.com' })).toBe('tok-beta');
    expect(store.resolveToken({ presetId: 'alpha', hostname: 'beta.example.com' })).toBe('tok-alpha'); // presetId wins
    expect(store.resolveToken({ presetId: 'nowhere', hostname: 'nowhere.example.com' })).toBe('');
  });

  it('tokens never leak into the file listing surface (§12.1)', async () => {
    const dir = freshDir();
    const store = new ManagedRemoteProfileStore(dir);
    await store.upsert({ id: 'alpha', name: 'Alpha', hostname: 'alpha.example.com', token: 'tok-secret' });
    expect(JSON.stringify(store.view())).not.toContain('tok-secret');
    // but the store FILE carries the run token (cloudflared reads it)
    const disk = JSON.parse(readFileSync(pathJoin(dir, MANAGED_REMOTE_STORE_FILE), 'utf8')) as { tunnels: Array<{ token: string }> };
    expect(disk.tunnels[0]!.token).toBe('tok-secret');
  });

  it('upsert removes entries conflicting with the new id OR hostname, then appends', async () => {
    const store = new ManagedRemoteProfileStore(freshDir());
    await store.upsert({ id: 'alpha', name: 'A', hostname: 'a.example.com', token: 't1' });
    await store.upsert({ id: 'alpha', name: 'A2', hostname: 'a.example.com', token: 't2' }); // same row replaced
    expect(store.list()).toHaveLength(1);
    await store.upsert({ id: 'gamma', name: 'G', hostname: 'a.example.com', token: 't3' }); // hostname conflict pushes alpha out
    expect(store.list().map((row) => row.id)).toEqual(['gamma']);
    await store.upsert({ id: 'gamma', name: 'G2', hostname: 'g.example.com', token: 't4' }); // id conflict self-replaces
    expect(store.list().map((row) => row.hostname)).toEqual(['g.example.com']);
  });

  it('sanitization drops invalid entries and dedupes on load (first wins)', () => {
    const dir = freshDir();
    writeFileSync(pathJoin(dir, MANAGED_REMOTE_STORE_FILE), JSON.stringify({
      version: 1,
      tunnels: [
        { id: 'one', name: 'One', hostname: 'ONE.example.com', token: 't',
          updatedAt: 123 },
        { id: 'one', name: 'Dup-Id', hostname: 'dup.example.com', token: 't' },
        { id: 'two', name: 'Dup-Host', hostname: 'one.example.com', token: 't' },
        { id: 'wild', name: 'Wildcard', hostname: '*.example.com', token: 't' },
        { id: 'missing-token', name: 'M', hostname: 'm.example.com' },
        'not-an-object',
      ],
    }), 'utf8');
    const store = new ManagedRemoteProfileStore(dir);
    expect(store.list().map((row) => row.id)).toEqual(['one']);
    expect(store.list()[0]!.hostname).toBe('one.example.com');
  });

  it('corrupt store refuses silently and heals only via explicit upsert (E-08-23 posture)', async () => {
    const dir = freshDir();
    writeFileSync(pathJoin(dir, MANAGED_REMOTE_STORE_FILE), '{definitely not json', 'utf8');
    const store = new ManagedRemoteProfileStore(dir);
    expect(store.list()).toEqual([]);
    expect(store.isCorrupt()).toBe(true);
    expect(store.hasToken()).toBe(false);
    await store.upsert({ id: 'heal', name: 'Heal', hostname: 'heal.example.com', token: 't9' });
    expect(store.isCorrupt()).toBe(false);
    expect(store.list().map((row) => row.id)).toEqual(['heal']);
  });

  it('model-shape corruption (version 2 / wrong tunnels field) also sets the latch', () => {
    const dir = freshDir();
    writeFileSync(pathJoin(dir, MANAGED_REMOTE_STORE_FILE), JSON.stringify({ version: 2, tunnels: [] }), 'utf8');
    const store = new ManagedRemoteProfileStore(dir);
    expect(store.list()).toEqual([]);
    expect(store.isCorrupt()).toBe(true);
  });

  it('syncWithPresets keeps only entries matching preset id or hostname; nothing while corrupt', async () => {
    const dir = freshDir();
    const store = new ManagedRemoteProfileStore(dir);
    await store.upsert({ id: 'keep', name: 'K', hostname: 'keep.example.com', token: 't' });
    await store.upsert({ id: 'drop', name: 'D', hostname: 'drop.example.com', token: 't' });
    await store.syncWithPresets([{ id: 'other', hostname: 'keep.example.com' }]);
    expect(store.list().map((row) => row.id)).toEqual(['keep']);
    writeFileSync(pathJoin(dir, MANAGED_REMOTE_STORE_FILE), 'garbage', 'utf8');
    const corruptStore = new ManagedRemoteProfileStore(dir);
    expect(corruptStore.isCorrupt()).toBe(true);
    await corruptStore.syncWithPresets([]);
    expect(corruptStore.list()).toEqual([]); // never healed by sync
  });

  it('legacy cloudflare-named-tunnels.json migrates on first read and stays in place', async () => {
    const dir = freshDir();
    writeFileSync(pathJoin(dir, LEGACY_NAMED_TUNNELS_FILE), JSON.stringify({
      version: 1,
      tunnels: [{ id: 'legacy', name: 'Legacy', hostname: 'legacy.example.com', token: 'tok-legacy' }],
    }), 'utf8');
    const store = new ManagedRemoteProfileStore(dir);
    expect(store.list().map((row) => row.id)).toEqual(['legacy']);
    expect(store.resolveToken({ presetId: 'legacy' })).toBe('tok-legacy');
    expect(existsSync(pathJoin(dir, LEGACY_NAMED_TUNNELS_FILE))).toBe(true);
    expect(existsSync(pathJoin(dir, MANAGED_REMOTE_STORE_FILE))).toBe(true);
  });

  it('an unreadable legacy store never invents tokens; new stores seed empty', () => {
    const dir = freshDir();
    writeFileSync(pathJoin(dir, LEGACY_NAMED_TUNNELS_FILE), '{{{', 'utf8');
    const store = new ManagedRemoteProfileStore(dir);
    expect(store.list()).toEqual([]);
    expect(existsSync(pathJoin(dir, MANAGED_REMOTE_STORE_FILE))).toBe(false);
  });

  it('upserts serialize through the promise-locked writer (ordering preserved)', async () => {
    const store = new ManagedRemoteProfileStore(freshDir());
    await Promise.all([
      store.upsert({ id: 'a', name: 'A', hostname: 'a.example.com', token: 't1' }),
      store.upsert({ id: 'b', name: 'B', hostname: 'b.example.com', token: 't2' }),
    ]);
    expect(store.list().map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('singleton first-caller options win; resets drop the instance', () => {
    const dir = freshDir();
    const first = getManagedRemoteProfileStore({ dataDir: dir });
    expect(getManagedRemoteProfileStore()).toBe(first); // no re-seed by later callers
    resetManagedRemoteProfileStoreForTests();
    expect(getManagedRemoteProfileStore({ dataDir: freshDir() })).not.toBe(first);
  });
});
