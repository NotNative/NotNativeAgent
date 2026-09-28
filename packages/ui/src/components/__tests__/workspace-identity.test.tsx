// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { WorkspaceIdentity, workspaceName } from '../workspace-identity.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

it('uses the final workspace segment on Windows and POSIX paths', () => {
  expect(workspaceName('D:\\ProjectRepo\\NotNativeDesktop\\')).toBe('NotNativeDesktop');
  expect(workspaceName('/work/nnd/')).toBe('nnd');
  expect(workspaceName('/')).toBe('Workspace');
});

it('keeps the header branch in sync with the selected workspace projection', () => {
  const store = createDirectoryStore();
  const other = createDirectoryStore();
  const stores = new Map([['D:/ProjectRepo/NotNativeDesktop', store], ['D:/ProjectRepo/Other', other]]);
  const ensureChild = vi.fn((directory: string) => stores.get(directory)!);
  const release = vi.fn();
  const pin = vi.fn(() => release);
  const engine = { childStoreOf: (directory: string) => stores.get(directory), manager: { ensureChild, pin } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<WorkspaceIdentity directory="D:/ProjectRepo/NotNativeDesktop" engine={engine} runtimeKey="local" />));
  expect(container.textContent).toBe('NotNativeDesktop');
  act(() => store.getState().patch({ vcs: { branch: 'main' } }));
  expect(container.textContent).toContain('main');
  act(() => root!.render(<WorkspaceIdentity directory="D:/ProjectRepo/Other" engine={engine} runtimeKey="local" />));
  expect(container.textContent).toBe('Other');
  expect(release).toHaveBeenCalledTimes(1);
  expect(pin).toHaveBeenLastCalledWith('D:/ProjectRepo/Other');
  act(() => other.getState().patch({ vcs: { branch: 'feature' } }));
  expect(container.textContent).toContain('feature');
  act(() => root!.render(<WorkspaceIdentity directory="D:/ProjectRepo/NotNativeDesktop" engine={engine} runtimeKey="local" />));
  expect(container.textContent).toContain('main');
  act(() => store.getState().patch({ vcs: null }));
  expect(container.textContent).toBe('NotNativeDesktop');
  expect(ensureChild).not.toHaveBeenCalled();
});

it('requests a missing workspace child once, rather than on each header update', () => {
  const store = createDirectoryStore();
  const ensureChild = vi.fn(() => store);
  const pin = vi.fn(() => () => undefined);
  const engine = { childStoreOf: () => undefined, manager: { ensureChild, pin } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<WorkspaceIdentity directory="D:/work" engine={engine} runtimeKey="local" />));
  expect(ensureChild).toHaveBeenCalledTimes(1);
  act(() => store.getState().patch({ vcs: { branch: 'main' } }));
  expect(container.textContent).toContain('main');
  expect(ensureChild).toHaveBeenCalledTimes(1);
  expect(pin).toHaveBeenCalledTimes(1);
});

it('drops the old branch when a runtime switch replaces the backing store', () => {
  const local = createDirectoryStore({ vcs: { branch: 'local-main' } });
  const remote = createDirectoryStore();
  let active = local;
  const release = vi.fn();
  const engine = { childStoreOf: () => active, manager: { ensureChild: () => active, pin: () => release } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<WorkspaceIdentity directory="D:/work" engine={engine} runtimeKey="local" />));
  expect(container.textContent).toContain('local-main');
  active = remote;
  act(() => root!.render(<WorkspaceIdentity directory="D:/work" engine={engine} runtimeKey="host:remote" />));
  expect(container.textContent).toBe('work');
  expect(release).toHaveBeenCalledTimes(1);
  act(() => remote.getState().patch({ vcs: { branch: 'remote-main' } }));
  expect(container.textContent).toContain('remote-main');
});
