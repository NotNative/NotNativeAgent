// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { TimelineDialog } from '../timeline-dialog.tsx';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

it('the timeline dialog exposes the transcript export action and downloads markdown', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const store = createDirectoryStore({
    message: { s1: [{ id: 'u1', sessionID: 's1', role: 'user', time: { created: 1 } } as Message] },
    part: { u1: [{ id: 'p1', sessionID: 's1', messageID: 'u1', type: 'text', text: 'hello' } as Part] },
  });
  const engine = {} as SyncEngine;
  await act(async () => root!.render(<TimelineDialog store={store} engine={engine} sessionID="s1" onClose={() => undefined} />));
  const button = container.querySelector('[data-testid="timeline-export"]') as HTMLButtonElement;
  expect(button).not.toBeNull();
  const created: Blob[] = [];
  const downloads: string[] = [];
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:x'; }, revokeObjectURL: () => undefined });
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(): void { downloads.push(this.download); };
  try {
    await act(async () => button.click());
    expect(downloads).toEqual(['s1.md']);
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe('text/markdown;charset=utf-8');
    expect(created[0]!.size).toBeGreaterThan(0);
  } finally { HTMLAnchorElement.prototype.click = original; vi.unstubAllGlobals(); }
});
