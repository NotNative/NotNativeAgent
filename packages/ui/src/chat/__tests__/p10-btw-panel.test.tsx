// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** P10-52 parent-side BTW panel lifecycle. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BtwPanel } from '../btw-panel.tsx';
import { metadataMarkBtwPromoted, metadataUnlinkBtwParent } from '../btw-context.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import type { Session } from '../../lib/nnd/types.ts';

vi.mock('../../lib/nnd/client.ts', () => ({
  normalizeDirectory: (value: string) => value,
  harnessClient: { getSession: vi.fn(), updateSession: vi.fn(), deleteSession: vi.fn() },
}));

const getSession = vi.mocked(harnessClient.getSession);
const updateSession = vi.mocked(harnessClient.updateSession);
const deleteSession = vi.mocked(harnessClient.deleteSession);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const child = session('child', 'D:/work', { openchamber: {
  kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: 'a0',
} });
const parent = session('parent', 'D:/work', { openchamber: { btwSessionID: 'child' } });

beforeEach(() => {
  getSession.mockReset();
  updateSession.mockReset();
  deleteSession.mockReset().mockResolvedValue({ data: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

function panel(onSelectSession = (id: string, _directory: string): void => { void id; },
  engineDelete: (sessionID: string, directory: string) => Promise<void> = async () => undefined): void {
  act(() => {
    root!.render(<BtwPanel session={child} parentSessionID="parent" childSessionID="child"
      directory="D:/work" engine={{ actions: { deleteSession: engineDelete } } as never}
      store={{ getState: () => ({ session: [child], message: {} }) }}
      onSelectSession={onSelectSession} />);
  });
}

describe('btw panel', () => {
  it('unlinks parent before deleting the fork', async () => {
    getSession.mockImplementation(async (id) => ({ data: (id === 'child' ? child : parent) as Session }));
    updateSession.mockImplementation(async (id, patch) => ({
      data: (id === 'child' ? { ...child, ...patch } : { ...parent, metadata: patch.metadata }) as Session,
    }));
    const engineDelete = vi.fn(async () => undefined);
    panel(undefined, engineDelete);
    const button = document.querySelector('[data-testid="btw-destroy"]') as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(updateSession).toHaveBeenCalledWith('parent', {
      metadata: metadataUnlinkBtwParent(parent.metadata, 'child'),
    }, { directory: 'D:/work' });
    expect(engineDelete).toHaveBeenCalledWith('child', 'D:/work');
  });

  it('promotes and navigates to the fork after unlink', async () => {
    const navigate = vi.fn();
    getSession.mockImplementation(async (id) => ({ data: (id === 'child' ? child : parent) as Session }));
    updateSession.mockImplementation(async (id, patch) => ({
      data: (id === 'child' ? { ...child, metadata: patch.metadata } : { ...parent, metadata: patch.metadata }) as Session,
    }));
    panel(navigate);
    const button = document.querySelector('[data-testid="btw-promote"]') as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(updateSession).toHaveBeenNthCalledWith(1, 'child', {
      metadata: metadataMarkBtwPromoted(child.metadata ?? {}),
    }, { directory: 'D:/work' });
    expect(navigate).toHaveBeenCalledWith('child', 'D:/work');
  });

});

function session(id: string, directory: string, metadata: unknown): Session {
  return { id, directory, metadata, title: `${id} title`, time: { created: 0, updated: 0 } } as unknown as Session;
}
