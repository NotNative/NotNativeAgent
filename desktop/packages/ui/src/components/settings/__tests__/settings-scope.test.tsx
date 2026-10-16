// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { I18nProvider } from '../../I18nProvider.tsx';
import { SettingsWindow } from '../window.tsx';
import { useSettingsEdit } from '../edit-boundary.tsx';
const runtime = vi.hoisted(() => ({ origin: 'http://127.0.0.1:3000', listeners: new Set<() => void>() }));
vi.mock('../../../lib/runtime-switch.ts', async original => ({ ...(await original<object>()), getRuntimeKey: () => 'local',
  onRuntimeEndpointChanged: (listener: () => void) => { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } }));
vi.mock('../../../lib/runtime-url.ts', async original => ({ ...(await original<object>()), getApiBaseUrl: () => runtime.origin }));
vi.mock('../pages/providers.tsx', () => ({ ProvidersPage: ScopeForm }));
function ScopeForm() {
  const [draft, setDraft] = useState(''); useSettingsEdit('Connection draft', Boolean(draft));
  return <input aria-label="Host form draft" value={draft} onChange={event => setDraft(event.target.value)} />;
}
it('remounts native forms on a same-key origin change and cancels queued navigation to the previous owner', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<I18nProvider><SettingsWindow initialPage="providers" nativeAlpha onClose={() => undefined} /></I18nProvider>));
    await act(async () => { const input = node.querySelector<HTMLInputElement>('[aria-label="Host form draft"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Host A draft'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click());
    expect(node.querySelector('dialog[aria-label="Unsaved settings"]')).not.toBeNull();
    await act(async () => { runtime.origin = 'http://127.0.0.1:4000'; for (const listener of [...runtime.listeners]) listener(); });
    expect(node.querySelector('dialog[aria-label="Unsaved settings"]')).toBeNull();
    expect(node.querySelector<HTMLInputElement>('[aria-label="Host form draft"]')!.value).toBe('');
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false);
  } finally { act(() => root.unmount()); node.remove(); runtime.listeners.clear(); }
});
