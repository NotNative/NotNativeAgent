// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** P10-52 parent-side BTW panel lifecycle, org-store edition. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BtwPanel } from '../btw-panel.tsx';
import { useSessionOrgStore, __resetSessionOrgStoreForTests } from '../../stores/useSessionOrgStore.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import type { Session } from '../../lib/nnd/types.ts';

vi.mock('../../lib/nnd/client.ts', () => ({
  normalizeDirectory: (value: string) => value,
  harnessClient: { getSession: vi.fn(), updateSession: vi.fn(), deleteSession: vi.fn() },
}));

const orgRecords: Record<string, Record<string, Record<string, unknown>>> = {};
const orgPosts: { sessionID: string; op: string; body: Record<string, unknown> }[] = [];
let failOrgOp: string | null = null;

vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/session-org')) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      directory: string; sessionID: string; op: string };
    orgPosts.push({ sessionID: body.sessionID, op: body.op, body });
    if (body.op === failOrgOp) return Response.json({ error: 'unlink failed' }, { status: 500 });
    const record = orgRecords[body.directory]?.[body.sessionID] ?? {};
    if (body.op === 'btw.setMarker') {
      record.btwMarker = { ...(body.marker as Record<string, unknown>),
        promoted: typeof body.promoted === 'boolean' ? body.promoted : false };
    }
    if (body.op === 'btw.clearChild' && record.btwChildOf === body.childSessionID) delete record.btwChildOf;
    if (body.op === 'btw.markPromoted' && record.btwMarker) {
      record.btwMarker = { ...record.btwMarker as Record<string, unknown>, promoted: true };
    }
    (orgRecords[body.directory] ??= {})[body.sessionID] = record;
    return Response.json({ success: true, record });
  }),
}));

const deleteSession = vi.mocked(harnessClient.deleteSession);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const child = session('child', 'D:/work', {});
const parent = session('parent', 'D:/work', {});

beforeEach(() => {
  deleteSession.mockReset().mockResolvedValue({ data: true });
  __resetSessionOrgStoreForTests();
  for (const key of Object.keys(orgRecords)) delete orgRecords[key];
  orgPosts.length = 0;
  failOrgOp = null;
  orgRecords['D:/work'] = {
    child: { btwMarker: { originalSessionID: 'parent', boundaryMessageID: 'a0', promoted: false } },
    parent: { btwChildOf: 'child' },
  };
  useSessionOrgStore.setState({
    recordsByDirectory: { 'D:/work': {
      child: { btwMarker: { originalSessionID: 'parent', boundaryMessageID: 'a0', promoted: false } },
      parent: { btwChildOf: 'child' },
    } },
    loadedDirectories: { 'D:/work': true },
  });
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
  it('unlinks the parent record before deleting the fork', async () => {
    const engineDelete = vi.fn(async () => undefined);
    panel(undefined, engineDelete);
    const button = document.querySelector('[data-testid="btw-destroy"]') as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(orgPosts.some((post) => post.sessionID === 'parent' && post.op === 'btw.clearChild')).toBe(true);
    expect(engineDelete).toHaveBeenCalledWith('child', 'D:/work');
  });

  it('promotes and navigates to the fork after unlink', async () => {
    const navigate = vi.fn();
    panel(navigate);
    const button = document.querySelector('[data-testid="btw-promote"]') as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(orgPosts.map((post) => `${post.sessionID}:${post.op}`))
      .toEqual(['child:btw.markPromoted', 'parent:btw.clearChild']);
    expect(useSessionOrgStore.getState().recordsByDirectory['D:/work']?.child?.btwMarker?.promoted).toBe(true);
    expect(useSessionOrgStore.getState().recordsByDirectory['D:/work']?.parent?.btwChildOf).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith('child', 'D:/work');
  });

  it('renders nothing without a recorded marker', () => {
    useSessionOrgStore.setState({ recordsByDirectory: { 'D:/work': {} }, loadedDirectories: { 'D:/work': true } });
    panel();
    expect(document.querySelector('[data-testid="btw-panel"]')).toBeNull();
  });

  it('reverts the promotion marker when the unlink fails', async () => {
    panel();
    const button = document.querySelector('[data-testid="btw-promote"]') as HTMLButtonElement;
    failOrgOp = 'btw.clearChild';
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    const rollback = orgPosts.filter((post) => post.sessionID === 'child' && post.op === 'btw.setMarker').at(-1);
    expect(rollback?.body.promoted).toBe(false); // the failed promote must not stick
    expect(useSessionOrgStore.getState().recordsByDirectory['D:/work']?.child?.btwMarker?.promoted).toBe(false);
  });

  it('keeps the legacy metadata path for sessions without an org record', async () => {
    const getSession = vi.mocked(harnessClient.getSession);
    const updateSession = vi.mocked(harnessClient.updateSession);
    useSessionOrgStore.setState({ recordsByDirectory: { 'D:/work': {} }, loadedDirectories: { 'D:/work': true } });
    const legacyChild = { ...child, metadata: { openchamber: {
      kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: 'a0' } } } as Session;
    const legacyParent = { ...parent, metadata: { openchamber: { btwSessionID: 'child' } } } as Session;
    getSession.mockImplementation(async (id) => ({ data: (id === 'child' ? legacyChild : legacyParent) as Session }));
    updateSession.mockImplementation(async (id, patch) => ({
      data: (id === 'child' ? { ...legacyChild, metadata: patch.metadata } : { ...legacyParent, metadata: patch.metadata }) as Session,
    }));
    act(() => {
      root!.render(<BtwPanel session={legacyChild} parentSessionID="parent" childSessionID="child"
        directory="D:/work" engine={{ actions: { deleteSession: vi.fn() } } as never}
        store={{ getState: () => ({ session: [legacyChild], message: {} }) }}
        onSelectSession={() => undefined} />);
    });
    const button = document.querySelector('[data-testid="btw-promote"]') as HTMLButtonElement;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(updateSession).toHaveBeenCalledWith('child', { metadata: {
      openchamber: { kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: 'a0', btwPromoted: true } } },
      { directory: 'D:/work' });
    expect(orgPosts).toEqual([]); // the legacy path never touches the org store
  });
});

function session(id: string, directory: string, metadata: Record<string, unknown>): Session {
  return { id, directory, metadata, title: '', time: { created: 0, updated: 0 } } as unknown as Session;
}
