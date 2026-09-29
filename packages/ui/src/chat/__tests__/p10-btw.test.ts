// SPDX-License-Identifier: Apache-2.0
/** P10-52 BTW contract tests (doc 15 §H.1). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  btwRiderFor, filterBtwTailMessages, lastCompletedAssistantID,
  metadataLinkBtwParent, metadataMarkBtwPromoted, metadataUnlinkBtwParent,
  metadataWithBtwFork, parseBtwMetadata,
} from '../btw-context.ts';

describe('p10 btw metadata and tail', () => {
  it('replaces the fork marker and preserves promotion state independently', () => {
    const forked = metadataLinkBtwParent({ openchamber: { goal: 'keep-parent-only' } }, 'child');
    expect(forked.openchamber).toEqual({ goal: 'keep-parent-only', btwSessionID: 'child' });
    const marked = metadataWithBtwFork({ title: 'kept', openchamber: { goal: 'inherited', btwSessionID: 'old' } }, {
      originalSessionID: 'parent', boundaryMessageID: 'boundary',
    });
    expect(marked.title).toBe('kept');
    expect(marked.openchamber).toEqual({ kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: 'boundary' });
    const active = parseBtwMetadata({
      openchamber: { kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: 'boundary' },
    });
    expect(active).toEqual({ active: true, promoted: false, originalSessionID: 'parent', boundaryMessageID: 'boundary' });
    const promoted = btwRiderFor(metadataMarkBtwPromoted({
      openchamber: { kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: 'boundary' },
    }));
    expect(promoted?.synthetic).toBe(true);
    expect(promoted?.text).toContain('promoted to a normal session');
    expect(metadataUnlinkBtwParent(forked, 'other').openchamber).toEqual(forked.openchamber);
    expect(metadataUnlinkBtwParent(forked, 'child').openchamber).toEqual({ goal: 'keep-parent-only' });
  });

  it('finds the completed assistant and filters only the inherited prefix', () => {
    const messages = [
      { id: 'u0', role: 'user', time: { created: 0 } },
      { id: 'a0', role: 'assistant', time: { created: 1, completed: 2 } },
      { id: 'u1', role: 'user', time: { created: 3 } },
      { id: 'a1', role: 'assistant', time: { created: 4 } },
    ] as never[];
    expect(lastCompletedAssistantID(messages)).toBe('a0');
    expect(lastCompletedAssistantID([{ id: 'head', role: 'assistant', time: { created: 9 } } as never])).toBeNull();
    const records = messages.map((message) => ({ ...(message as object), id: (message as { id: string }).id }));
    expect(filterBtwTailMessages(records, 'a0').map((record) => (record as { id: string }).id)).toEqual(['u1', 'a1']);
    expect(filterBtwTailMessages(records, 'missing')).toHaveLength(4);
    expect(filterBtwTailMessages(records, null)).toHaveLength(4);
  });
});
