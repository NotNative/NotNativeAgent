// SPDX-License-Identifier: Apache-2.0
/** Snippet source store pins (P9-4e-ii): the roster publishes on a
 * successful load, failed requests keep the current roster silently, the
 * map is replaced wholesale so useSyncExternalStore sees every load, and
 * snapshot-at-open readers get sorted names. */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { listSnippets } from '../snippets-api.ts';
import {
  __resetSnippetsSourceForTests, refreshSnippets, snippetMap, snippetNames, snippetSubscribe,
} from '../snippets-source.ts';

vi.mock('../snippets-api.ts', () => ({ listSnippets: vi.fn() }));

const list = listSnippets as unknown as Mock;

beforeEach(() => {
  __resetSnippetsSourceForTests();
  list.mockReset();
});

describe('snippets source store', () => {
  it('a successful load publishes the server roster and notifies', async () => {
    const snapshots: Map<string, string>[] = [];
    const stop = snippetSubscribe(() => { snapshots.push(snippetMap()); });
    list.mockResolvedValue({
      ok: true,
      snippets: [
        { name: 'sig', text: 'sig-text', scope: 'global' },
        { name: 'heb', text: 'heb-text', scope: 'global' },
      ],
    });
    await refreshSnippets();
    expect(snippetMap().get('sig')).toBe('sig-text');
    expect(snippetNames()).toEqual(['sig', 'heb']);
    expect(snapshots.length).toBe(1);
    stop();
  });

  it('a refused or rejected load keeps the current roster (same instance)', async () => {
    list.mockResolvedValue({ ok: true, snippets: [{ name: 'sig', text: 'sig-text' }] });
    await refreshSnippets();
    const before = snippetMap();
    list.mockResolvedValue({ ok: false, status: 500, error: 'snippet request failed (500)' });
    await expect(refreshSnippets()).resolves.toBe(before);
    list.mockRejectedValue(new Error('socket down'));
    await expect(refreshSnippets()).resolves.toBe(before);
    expect(snippetNames()).toEqual(['sig']);
  });

  it('each successful load replaces the map wholesale', async () => {
    list.mockResolvedValue({ ok: true, snippets: [{ name: 'a', text: '1' }] });
    await refreshSnippets();
    const first = snippetMap();
    list.mockResolvedValue({ ok: true, snippets: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    await refreshSnippets();
    expect(snippetMap()).not.toBe(first);
    expect(snippetMap().size).toBe(2);
  });

  it('a 200 without the snippets array keeps the roster and never rejects', async () => {
    // Defect probe: `refreshSnippets` trusted `outcome.snippets` after
    // `outcome.ok` - and a fulfilment-handler THROW does NOT route into the
    // sibling rejection handler, so the composer's mount effect
    // (`void refreshSnippets()`) became an unhandled rejection on any
    // hostile 200. Malformed payloads fold to the registered failure
    // posture: the current roster stays, nothing republishes.
    list.mockResolvedValue({ ok: true, snippets: [{ name: 'sig', text: 'sig-text' }] });
    await refreshSnippets();
    const before = snippetMap();
    const snapshots: Map<string, string>[] = [];
    const stop = snippetSubscribe(() => { snapshots.push(snippetMap()); });
    list.mockResolvedValue({ ok: true }); // hostile body: ok, no array
    await expect(refreshSnippets()).resolves.toBe(before);
    expect(snapshots.length).toBe(0);
    expect(snippetNames()).toEqual(['sig']);
    stop();
  });
});
