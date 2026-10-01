// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { __resetSettingsStoreForTests, useSettingsStore } from '../../../lib/settings/store.ts';
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from '../../../stores/useMessageQueueStore.ts';
import { ChatPage } from '../pages/chat.tsx';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(): HTMLSelectElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<I18nProvider><ChatPage /></I18nProvider>); });
  return container.querySelector('[data-settings-item="chat.follow-up"] select') as HTMLSelectElement;
}

beforeEach(() => { __resetSettingsStoreForTests(); });

afterEach(() => {
  if (root !== null) { const mounted = root; act(() => { mounted.unmount(); }); root = null; }
  if (container !== null) { container.remove(); container = null; }
  __resetSettingsStoreForTests();
});

describe('Chat follow-up setting default', () => {
  it('shows queue when no persisted preference exists (§D.7)', () => {
    expect(mount().value).toBe(DEFAULT_FOLLOW_UP_BEHAVIOR);
  });

  it('continues to show an explicitly saved steer preference', () => {
    useSettingsStore.setState({ doc: { followUpBehavior: 'steer' }, loading: false, loadError: false });
    expect(mount().value).toBe('steer');
  });

  it('normalizes an invalid legacy value to queue in the setting control', () => {
    useSettingsStore.setState({ doc: { followUpBehavior: 'immediate' }, loading: false, loadError: false });
    expect(mount().value).toBe('queue');
  });

  it('reset returns an explicit steer preference to the queue default', () => {
    useSettingsStore.setState({ doc: { followUpBehavior: 'steer' }, loading: false, loadError: false });
    const select = mount();
    const reset = container!.querySelector('[data-settings-item="chat.follow-up"] button[title="Reset"]') as HTMLButtonElement;
    act(() => { reset.click(); });
    expect(select.value).toBe('queue');
    expect(useSettingsStore.getState().doc['followUpBehavior']).toBe('queue');
  });
});
