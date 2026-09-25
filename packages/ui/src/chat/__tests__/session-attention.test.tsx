// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '../../lib/nnd/types.ts';
import { ChatSidebar, sessionAttention } from '../session-sidebar.tsx';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useSessionFoldersStore } from '../../stores/useSessionFoldersStore.ts';

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
      const row = node.querySelector('[data-child-session="true"]')!;
      expect(row.getAttribute('data-attention')).toBe('needs input');
      expect(row.textContent).toContain('needs input');
    } finally {
      act(() => root.unmount()); node.remove();
      useGlobalSessionsStore.getState().reset();
      useSessionFoldersStore.setState({ load: originalLoad });
    }
  });
});
