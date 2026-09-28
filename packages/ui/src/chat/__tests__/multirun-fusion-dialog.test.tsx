// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom
 * P9-5d dialog wiring: catalog default, template, source count, dispatch parts,
 * and the no-outputs toast failure path without creating a session. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create, type StoreApi } from 'zustand';
import { INITIAL_STATE, type DirectoryStore } from '../../sync/types.ts';
import type { MessageEntry, Part, Provider, Session } from '../../lib/nnd/types.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useAuthSessionStore } from '../../lib/runtime-auth-expiry.ts';
import { MultiRunFusionDialog } from '../multirun-fusion-dialog.tsx';
import type { SyncEngine } from '../../sync/sync-engine.ts';

vi.mock('../../lib/server-api.ts', () => ({
  listMagicPromptOverrides: vi.fn(async () => ({ 'session.fusion.instructions': 'Combine hidden inputs.' })),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  gitStatus: vi.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

beforeEach(() => {
  useAuthSessionStore.setState({ status: 'ok' });
  useGlobalSessionsStore.setState({ status: 'ready', active: [], archived: [], hasLoaded: true, lastError: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => rootHandle?.unmount());
  rootHandle = null;
  container?.remove();
  container = null;
  useGlobalSessionsStore.setState({ active: [], archived: [], status: 'idle' });
});

describe('multi-run fusion dialog', () => {
  it('collects matching sessions and dispatches the visible prompt plus hidden synthetic inputs', async () => {
    const session = testSession({ id: 's_match', title: 'rework/mock/fast', directory: 'C:/wt-match', created: 1 });
    const trigger = testSession({ id: 's_trigger', title: 'rework/openai/alpha', directory: 'C:/repo', created: 10 });
    useGlobalSessionsStore.setState({ active: [session], archived: [] });
    const store = create(() => storeWithOutput(trigger.id, providerState())) as unknown as StoreApi<DirectoryStore>;
    vi.spyOn(harnessClient, 'listMessages').mockResolvedValue({
      data: [{
        info: { id: 'msg_match', role: 'assistant', time: { created: 2 }, error: undefined },
        parts: [{ id: 'part_match', sessionID: '', messageID: 'msg_match', type: 'text', text: 'First answer' }],
      }],
    } as never);
    const createSessionAction = vi.fn().mockResolvedValue(testSession({
      id: 's_fused', title: 'rework/mock/fast/fusion', directory: 'C:/repo', created: 50,
    }));
    const send = vi.fn();
    renderFusionDialog(trigger, store, { createSessionAction, send });
    expect(document.querySelector('[data-testid="fusion-start"]')!.textContent).toContain('Start fusion');
    expect((document.querySelector('[data-testid="fusion-dialog"]')!.textContent ?? '').includes('2 source')).toBe(true);
    expect((document.querySelector('[data-testid="fusion-open-model-picker"]')!.textContent ?? '').includes('mock · fast')).toBe(true);
    renderFusionDialog(trigger, store, { createSessionAction, send });
    await act(async () => {
      await click(document.querySelector('[data-testid="fusion-start"]'));
    });
    expect(createSessionAction).toHaveBeenCalledWith({ directory: 'C:/repo', title: 'rework/mock/fast/fusion' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      directory: 'C:/repo',
      sessionID: 's_fused',
      model: { providerID: 'mock', modelID: 'fast' },
      parts: expect.arrayContaining([
        { type: 'text', text: 'Reconcile the following 2 competing outputs into a single final answer.' },
        { type: 'text', text: 'Combine hidden inputs.', synthetic: true },
      ]),
    }));
  });

  it('reports no outputs without creating or sending', async () => {
    const trigger = testSession({ id: 's_trigger', title: 'rework/openai/alpha', directory: 'C:/repo', created: 10 });
    const store = create(() => providerState()) as unknown as StoreApi<DirectoryStore>;
    const createSessionAction = vi.fn();
    const send = vi.fn();
    vi.spyOn(harnessClient, 'listMessages').mockResolvedValue({ data: [] } as never);
    renderFusionDialog(trigger, store, { createSessionAction, send });
    await act(async () => {
      await click(document.querySelector('[data-testid="fusion-start"]'));
    });
    expect(createSessionAction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(harnessClient.listMessages).toHaveBeenCalledTimes(1);
  });
});

function renderFusionDialog(
  trigger: Session,
  store: StoreApi<DirectoryStore>,
  actionOverrides: { createSessionAction: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> },
): { close: () => void } {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  const engine = {
    childStoreOf: () => undefined,
    routingDirectoryOf: () => 'C:/repo',
    actions: { createSession: actionOverrides.createSessionAction, send: actionOverrides.send },
  } as unknown as SyncEngine;
  const render = (visible: boolean): void => {
    act(() => {
      rootHandle!.render(visible ? <MultiRunFusionDialog
      services={{ engine, store: () => store, dispatch: () => undefined }}
      trigger={trigger}
      identity={{ groupSlug: 'rework', providerID: 'openai', modelID: 'alpha', fusion: false }}
      onClose={() => { visible = false; render(false); }} /> : null);
    });
  };
  render(true);
  return { close: () => render(false) };
}

function providerState(): DirectoryStore {
  const state = structuredClone(INITIAL_STATE) as DirectoryStore;
  state.config = {};
  state.provider = [provider('mock', { fast: 'Fast' })];
  return state;
}

function storeWithOutput(sessionID: string, base: DirectoryStore): DirectoryStore {
  const message: MessageEntry['info'] = {
    id: 'msg_out', sessionID, role: 'assistant', time: { created: 2 },
  } as never;
  const part: Part = { id: 'part_out', sessionID: '', messageID: 'msg_out', type: 'text', text: 'First answer' };
  return {
    ...base,
    message: { [sessionID]: [message] },
    part: { msg_out: [part] },
  };
}

function provider(id: string, models: Record<string, string>): Provider {
  const mapped: Provider['models'] = {};
  for (const [modelID, name] of Object.entries(models)) {
    mapped[modelID] = { id: modelID, providerID: id, name } as never;
  }
  return { id, name: id, models: mapped } as Provider;
}

function testSession(input: { id: string; title: string; directory: string; created: number }): Session {
  return {
    id: input.id,
    slug: input.title,
    projectID: 'p',
    directory: input.directory,
    title: input.title,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    version: '1',
    metadata: { projectDirectory: 'C:/repo' },
    time: { created: input.created, updated: input.created },
  } as never;
}

async function click(control: Element | null): Promise<void> {
  expect(control).not.toBeNull();
  await act(async () => { control!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

