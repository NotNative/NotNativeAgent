// SPDX-License-Identifier: Apache-2.0
/**
 * Command palette (W-05.command-palette): a mod+p overlay that filters a
 * flat command list (navigation + session actions) with typeahead and runs
 * the selected command on Enter/click. The palette holds no state of its own
 * beyond the open flag and the query — every command delegates to the same
 * actions the sidebar uses, so the palette can never bypass authority.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { useGlobalSessionsStore } from '../sync/global-stores.ts';

interface CommandPaletteState { open: boolean; setOpen: (open: boolean) => void }

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openCommandPalette(): void {
  useCommandPaletteStore.getState().setOpen(true);
}

export interface PaletteCommand { id: string; label: string; run: () => void }

export interface CommandPaletteProps {
  actions: {
    openDraft: (directory: string) => void;
    openSession: (sessionID: string, directory: string) => void;
  };
  currentDirectory: string;
  onOpenArchive?: () => void;
  onOpenSettings?: () => void;
}

/** The command list: new draft, settings, archive, then open-session rows. */
export function paletteCommands(props: CommandPaletteProps): PaletteCommand[] {
  const sessions = useGlobalSessionsStore.getState().active;
  const commands: PaletteCommand[] = [
    { id: 'new-chat', label: 'New chat', run: () => props.actions.openDraft(props.currentDirectory) },
    ...(props.onOpenSettings ? [{ id: 'open-settings', label: 'Open settings', run: props.onOpenSettings }] : []),
    ...(props.onOpenArchive ? [{ id: 'open-archive', label: 'Show archived sessions', run: props.onOpenArchive }] : []),
    ...sessions.map((session) => ({
      id: `open-${session.id}`,
      label: `Open: ${session.title || 'Untitled Session'}`,
      run: () => props.actions.openSession(session.id, session.directory ?? props.currentDirectory),
    })),
  ];
  return commands;
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return commands;
  return commands.filter((command) => command.label.toLowerCase().includes(needle));
}

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const open = useCommandPaletteStore((state) => state.open);
  const setOpen = useCommandPaletteStore((state) => state.setOpen);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    inputRef.current?.focus();
  }, [open]);

  const commands = useMemo(() => filterCommands(paletteCommands(props), query), [props, query]);
  useEffect(() => { setSelected((at) => Math.min(at, Math.max(0, commands.length - 1))); }, [commands.length]);

  if (!open) return null;
  const run = (command: PaletteCommand | undefined): void => {
    if (!command) return;
    setOpen(false);
    command.run();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((at) => Math.min(at + 1, commands.length - 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((at) => Math.max(at - 1, 0)); return; }
    if (event.key === 'Enter') { event.preventDefault(); run(commands[selected]); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-popover/50 pt-[12vh]" data-testid="command-palette"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="w-[min(560px,92vw)] overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <input ref={inputRef} data-testid="command-palette-input" value={query} placeholder="Type a command…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground outline-none"
          onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} role="combobox"
          aria-expanded aria-controls="command-palette-list" aria-label="Command palette" />
        <ul id="command-palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
          {commands.map((command, at) => (
            <li key={command.id} role="option" aria-selected={at === selected}>
              <button type="button" data-testid="command-palette-item"
                className={`flex w-full items-center px-4 py-2 text-left text-[length:var(--type-markdown)] ${at === selected ? 'bg-card text-foreground' : 'text-muted-foreground'}`}
                onMouseEnter={() => setSelected(at)} onClick={() => run(command)}>
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
              </button>
            </li>
          ))}
          {commands.length === 0 ? <li className="px-4 py-3 text-[length:var(--type-markdown)] text-muted-foreground" data-testid="command-palette-empty">No matching command</li> : null}
        </ul>
      </div>
    </div>
  );
}
