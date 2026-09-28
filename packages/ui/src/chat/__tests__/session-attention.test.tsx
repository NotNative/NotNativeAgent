// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '../../lib/nnd/types.ts';
import { ChatSidebar, childActivityPhrase, sessionAttention } from '../session-sidebar.tsx';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useSessionFoldersStore } from '../../stores/useSessionFoldersStore.ts';
import { useSessionExpansionStore } from '../../stores/useSessionExpansionStore.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function session(nnd: unknown): Session {
  return { id: 's1', slug: 's1', projectID: 'work', directory: '/work', title: 'Session', version: '1.0',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, metadata: { nnd } };
}

describe('session navigator attention', () => {
  it('keeps an authored needs-input disposition visible after transport settles idle', () => {
    expect(sessionAttention(session({ attention: { kind: 'needs_input' }, turnState: { phase: 'idle' } }))).toBe('needs input');
    expect(sessionAttention(session({ turnState: { phase: 'awaiting_approval' } }))).toBe('approval pending');
    expect(sessionAttention(session({ turnState: { phase: 'attention_required' } }))).toBe('needs input');
  });

  it('does not invent attention from unrelated or malformed metadata', () => {
    expect(sessionAttention(session(null))).toBeNull();
    expect(sessionAttention(session({ turnState: { phase: 'running_tool' } }))).toBeNull();
    expect(sessionAttention(session({ attention: { kind: 'unknown' }, turnState: { phase: 'idle' } }))).toBeNull();
    expect(sessionAttention(session({ attention: 'needs_input' }))).toBeNull();
  });

  it('labels only NNA-authored active child phases, without reinterpreting idle or unknown values', () => {
    expect(childActivityPhrase({ nnd: { turnState: { phase: 'running_tool' } } })).toBe('using tool');
    expect(childActivityPhrase({ nnd: { turnState: { phase: 'waiting_provider' } } })).toBe('waiting for model');
    expect(childActivityPhrase({ nnd: { turnState: { phase: 'idle' } } })).toBeNull();
    expect(childActivityPhrase({ nnd: { turnState: { phase: 'unknown' } } })).toBeNull();
    expect(childActivityPhrase({ nnd: { turnState: 'running_tool' } })).toBeNull();
    expect(childActivityPhrase({ nnd: { turnState: { phase: 'running_tool' },
      activeTools: { count: 2, names: ['shell_run', 'edit'] } } })).toBe('using shell_run +1');
    expect(childActivityPhrase({ nnd: { turnState: { phase: 'running_tool' },
      activeTools: { count: 0, names: [] } } })).toBeNull();
    expect(childActivityPhrase({ nnd: { turnState: { phase: 'running_tool' },
      activeTools: { count: 1, names: ['shell_run\nprivate'] } } })).toBe('using tool');
  });

  it('renders the authored attention badge for a child session after its live status becomes idle', () => {
    const originalLoad = useSessionFoldersStore.getState().load;
    useSessionFoldersStore.setState({ load: async () => undefined });
    const child = { ...session({ attention: { kind: 'needs_input' }, turnState: { phase: 'idle' } }),
      parentID: 'parent', title: 'Research child', directory: '/work', time: { created: 2, updated: 2 } };
    const parent = { ...session({ turnState: { phase: 'idle' } }), id: 'parent', title: 'Parent',
      directory: '/work', time: { created: 1, updated: 1 } };
    useGlobalSessionsStore.getState().upsertSession(parent);
    useGlobalSessionsStore.getState().upsertSession(child);
    const node = document.createElement('div'); document.body.appendChild(node);
    const root = createRoot(node);
    try {
      act(() => root.render(<ChatSidebar engine={{} as never} currentDirectory="/work" currentSessionId={null}
        actions={{ openDraft: () => undefined, openSession: () => undefined, rename: async () => undefined,
          archive: async () => undefined, restore: async () => undefined, deleteSession: async () => undefined }} />));
      expect(node.querySelector('[data-child-session="true"]')).toBeNull();
      expect(node.querySelector('[data-testid="collapsed-subtask-attention"]')?.textContent).toContain('1 subtask needs attention');
      act(() => (node.querySelector('[aria-label="Expand Parent subtasks"]') as HTMLButtonElement).click());
      const row = node.querySelector('[data-child-session="true"]')!;
      expect(row.getAttribute('data-attention')).toBe('needs input');
      expect(row.textContent).toContain('needs input');
      expect(node.querySelector('[data-testid="collapsed-subtask-attention"]')).toBeNull();
    } finally {
      act(() => root.unmount()); node.remove();
      useGlobalSessionsStore.getState().reset();
      useSessionExpansionStore.setState({ expanded: {} });
      localStorage.removeItem('nnd.sessions.expanded.v1');
      useSessionFoldersStore.setState({ load: originalLoad });
    }
  });

  it('surfaces attention from a child older than the recent-row cap on its collapsed parent', () => {
    const originalLoad = useSessionFoldersStore.getState().load;
    useSessionFoldersStore.setState({ load: async () => undefined });
    const parent = { ...session(null), id: 'parent', title: 'Parent', time: { created: 100, updated: 100 } };
    const child = { ...session({ turnState: { phase: 'awaiting_approval' } }), id: 'child', parentID: 'parent',
      title: 'Old child', time: { created: 1, updated: 1 } };
    const newer = Array.from({ length: 50 }, (_, index) => ({ ...session(null), id: `new-${index}`,
      title: `New ${index}`, time: { created: 200 + index, updated: 200 + index } }));
    useGlobalSessionsStore.setState({ active: [...newer, parent, child] });
    const node = document.createElement('div'); document.body.appendChild(node);
    const root = createRoot(node);
    try {
      act(() => root.render(<ChatSidebar engine={{} as never} currentDirectory="/work" currentSessionId={null}
        actions={{ openDraft: () => undefined, openSession: () => undefined, rename: async () => undefined,
          archive: async () => undefined, restore: async () => undefined, deleteSession: async () => undefined }} />));
      // Both parent and child are older than the cap but must stay navigable.
      expect(node.querySelector('[aria-label="Expand Parent subtasks"]')).not.toBeNull();
      expect(node.querySelector('[data-child-session="true"]')).toBeNull();
      expect(node.querySelector('[data-testid="collapsed-subtask-attention"]')?.textContent).toContain('1 subtask needs attention');
      act(() => (node.querySelector('[aria-label="Expand Parent subtasks"]') as HTMLButtonElement).click());
      expect(node.querySelector('[data-child-session="true"]')?.textContent).toContain('approval pending');
    } finally {
      act(() => root.unmount()); node.remove();
      useGlobalSessionsStore.getState().reset();
      useSessionExpansionStore.setState({ expanded: {} });
      localStorage.removeItem('nnd.sessions.expanded.v1');
      useSessionFoldersStore.setState({ load: originalLoad });
    }
  });

  it('updates a child row from an authored phase and lets attention take precedence', () => {
    const originalLoad = useSessionFoldersStore.getState().load;
    useSessionFoldersStore.setState({ load: async () => undefined });
    const child = { ...session({ turnState: { phase: 'running_tool' }, activeTools: { count: 1, names: ['shell_run'] } }), id: 'child', parentID: 'parent', title: 'Research',
      time: { created: 2, updated: 2 } };
    useGlobalSessionsStore.setState({ active: [session(null), child] });
    const node = document.createElement('div'); document.body.appendChild(node);
    const root = createRoot(node);
    try {
      act(() => root.render(<ChatSidebar engine={{} as never} currentDirectory="/work" currentSessionId={null}
        actions={{ openDraft: () => undefined, openSession: () => undefined, rename: async () => undefined,
          archive: async () => undefined, restore: async () => undefined, deleteSession: async () => undefined }} />));
      expect(node.querySelector('[data-child-session="true"] [data-testid="child-current-activity"]')?.textContent).toContain('using shell_run');
      act(() => useGlobalSessionsStore.setState({ active: [session(null), { ...child, metadata: { nnd: {
        turnState: { phase: 'running_tool' }, activeTools: { count: 0, names: [] },
      } } }] }));
      expect(node.querySelector('[data-child-session="true"] [data-testid="child-current-activity"]')).toBeNull();
      act(() => useGlobalSessionsStore.setState({ active: [session(null), { ...child, metadata: { nnd: {
        attention: { kind: 'needs_input' }, turnState: { phase: 'running_tool' },
      } } }] }));
      const row = node.querySelector('[data-child-session="true"]')!;
      expect(row.textContent).toContain('needs input');
      expect(row.querySelector('[data-testid="child-current-activity"]')).toBeNull();
    } finally {
      act(() => root.unmount()); node.remove();
      useGlobalSessionsStore.getState().reset();
      useSessionFoldersStore.setState({ load: originalLoad });
    }
  });

  it('shows root tool work in the session navigator without borrowing a sibling snapshot', () => {
    const originalLoad = useSessionFoldersStore.getState().load;
    useSessionFoldersStore.setState({ load: async () => undefined });
    useGlobalSessionsStore.setState({ active: [session({ activeTools: { count: 1, names: ['edit'] },
      turnState: { phase: 'running_tool' } }), { ...session({ activeTools: { count: 1, names: ['shell_run'] } }),
      id: 's2', title: 'Sibling', time: { created: 2, updated: 2 } }] });
    const node = document.createElement('div'); document.body.appendChild(node);
    const root = createRoot(node);
    try {
      act(() => root.render(<ChatSidebar engine={{} as never} currentDirectory="/work" currentSessionId={null}
        actions={{ openDraft: () => undefined, openSession: () => undefined, rename: async () => undefined,
          archive: async () => undefined, restore: async () => undefined, deleteSession: async () => undefined }} />));
      const rows = node.querySelectorAll('[data-testid="session-row"]');
      expect([...rows].some((row) => row.textContent?.includes('using edit'))).toBe(true);
      expect([...rows].some((row) => row.textContent?.includes('using shell_run'))).toBe(true);
    } finally {
      act(() => root.unmount()); node.remove();
      useGlobalSessionsStore.getState().reset();
      useSessionFoldersStore.setState({ load: originalLoad });
    }
  });
});
