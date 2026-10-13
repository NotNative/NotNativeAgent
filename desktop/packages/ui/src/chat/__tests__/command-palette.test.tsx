// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandPalette, filterCommands, openCommandPalette, paletteCommands, useCommandPaletteStore,
  type CommandPaletteProps, type PaletteCommand } from '../command-palette.tsx';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useCommandPaletteStore.setState({ open: false });
  useSessionViewStore.setState({ activeDirectory: 'D:/work', currentSessionId: null });
  useGlobalSessionsStore.setState({
    active: [
      { id: 's1', directory: 'D:/work', title: 'Login bug', time: {} },
      { id: 's2', directory: 'D:/other', title: '', time: {} },
    ] as never,
    archived: [], hasLoaded: true, status: 'ready',
  });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useGlobalSessionsStore.getState().reset();
});

function props(): CommandPaletteProps {
  return {
    actions: {
      openDraft: vi.fn(),
      openSession: vi.fn(),
    },
    currentDirectory: 'D:/work',
    onOpenArchive: vi.fn(),
    onOpenSettings: vi.fn(),
  };
}

function mount(p: CommandPaletteProps): { node: HTMLDivElement; p: CommandPaletteProps } {
  act(() => root!.render(<CommandPalette {...p} />));
  return { node: container!, p };
}

function items(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-item"]')];
}

it('paletteCommands lists navigation commands plus one open row per active session', () => {
  const p = props();
  const commands = paletteCommands(p);
  expect(commands.map((command) => command.id)).toEqual(['new-chat', 'open-settings', 'open-archive', 'open-s1', 'open-s2']);
  act(() => { commands.at(-1)!.run(); });
  expect(p.actions.openSession).toHaveBeenCalledWith('s2', 'D:/other');
  act(() => { commands[0]!.run(); });
  expect(p.actions.openDraft).toHaveBeenCalledWith('D:/work');
});

it('filterCommands narrows case-insensitively on the label', () => {
  const commands: PaletteCommand[] = [
    { id: 'a', label: 'New chat', run: () => undefined },
    { id: 'b', label: 'Open: Login bug', run: () => undefined },
  ];
  expect(filterCommands(commands, 'LOGIN').map((command) => command.id)).toEqual(['b']);
  expect(filterCommands(commands, '  ')).toHaveLength(2);
  expect(filterCommands(commands, 'zzz')).toEqual([]);
});

it('typeahead narrows, Enter runs the selection and closes, arrows move it', async () => {
  const p = props();
  act(() => openCommandPalette());
  mount(p);
  const input = document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
  expect(input).toBeTruthy();
  expect(document.activeElement).toBe(input);
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
  // React controlled input: drive via the native value setter.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, 'login'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
  const narrowed = items();
  expect(narrowed).toHaveLength(1);
  const row = narrowed[0]!;
  expect(row.textContent).toContain('Open: Login bug');
  expect(row.closest('li')?.getAttribute('aria-selected')).toBe('true');
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(p.actions.openSession).toHaveBeenCalledWith('s1', 'D:/work');
  expect(useCommandPaletteStore.getState().open).toBe(false);
  expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
});

it('Escape closes without running and click runs a visible command', async () => {
  const p = props();
  act(() => openCommandPalette());
  mount(p);
  const input = document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(p.actions.openDraft).not.toHaveBeenCalled();
  expect(useCommandPaletteStore.getState().open).toBe(false);
  act(() => openCommandPalette());
  const first = items()[0]!;
  expect(first).toBeTruthy();
  act(() => { first.click(); });
  expect(p.actions.openDraft).toHaveBeenCalledWith('D:/work');
  expect(useCommandPaletteStore.getState().open).toBe(false);
});
