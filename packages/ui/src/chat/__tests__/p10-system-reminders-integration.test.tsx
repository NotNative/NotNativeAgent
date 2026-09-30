// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';
import { Composer } from '../composer.tsx';
import { __resetSettingsStoreForTests, useSettingsStore } from '../../lib/settings/store.ts';
import { INITIAL_STATE, type DirectoryStore } from '../../sync/types.ts';

type Sent = { parts: { text?: string; synthetic?: boolean }[]; sessionID?: string };
let root: Root | null = null;
const reminder = '<system-reminder>\nRespond as a mentor: explain the reasoning and teach transferable patterns.\n</system-reminder>';


function render(
  sessionID: string | null,
  overrides: Partial<DirectoryStore> = {},
  send = vi.fn(async (_parts: Sent) => undefined),
  createSession?: () => Promise<{ id: string }>,
) {
  const state = { ...INITIAL_STATE, config: {}, ...overrides, patch: () => undefined, replace: () => undefined };
  const reduxStore = { subscribe: () => () => undefined, getState: () => state } as unknown as StoreApi<DirectoryStore>;
  const actions = { send: (input: Sent) => send(input), ...(createSession ? { createSession } : {}) };
  return act(async () => {
    root!.render(<Composer
      services={{ engine: { actions } as never, store: () => reduxStore, dispatch: () => undefined }}
      sessionID={sessionID}
      directory="/proj"
      sessionKey={sessionID ?? 'draft'}
    />);
  });
}

beforeEach(async () => {
  __resetSettingsStoreForTests();
  useSettingsStore.setState({
    doc: { responseStyleEnabled: true, responseStylePreset: 'mentor' },
    loading: false,
    loadError: false,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  const bodyContainer = document.createElement('div');
  document.body.append(bodyContainer);
  root = createRoot(bodyContainer);
  await Promise.resolve();
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
});

describe('response-style reminders', () => {
  it('appends one preset reminder to a draft materialization', async () => {
    const send = vi.fn(async (_parts: Sent) => undefined);
    const createSession = vi.fn(async () => ({ id: 'fresh' }));
    await render(null, {}, send, createSession);
    await submitEditor('fresh message');
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.parts.map((part) => ({ text: part.text, synthetic: part.synthetic }))).toEqual([
      expect.objectContaining({ text: 'fresh message' }),
      { text: reminder, synthetic: true },
    ]);
  });

  it('skips active BTW sessions', async () => {
    const send = vi.fn(async (_parts: Sent) => undefined);
    await render('btw1', {
      session: [{ id: 'btw1', metadata: {
        openchamber: { kind: 'btw', originalSessionID: 'main' } } } as never],
    }, send);
    await submitEditor('question');
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.parts.some((part) => part.text?.includes('<system-reminder>'))).toBe(false);
    expect(sent?.parts.some((part) => part.text === 'question')).toBe(true);
  });

  it('rides an existing idle session with no visible messages', async () => {
    const send = vi.fn(async (_parts: Sent) => undefined);
    await render('fresh-session', {}, send);
    await submitEditor('first message');
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.sessionID).toBe('fresh-session');
    expect(sent?.parts[1]).toEqual(expect.objectContaining({ type: 'text', text: reminder, synthetic: true }));
  });
});

function submitEditor(text: string) {
  const editor = document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
  return act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-testid="composer"]') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
