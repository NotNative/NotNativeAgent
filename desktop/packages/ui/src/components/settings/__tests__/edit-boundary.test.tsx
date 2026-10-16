// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsEditBoundary, useSettingsEdit, useSettingsLeave } from '../edit-boundary.tsx';
import { SettingsTabs } from '../section-tabs.tsx';
const runtime = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock('../../../lib/runtime-switch.ts', async original => ({ ...(await original<object>()),
  onRuntimeEndpointChanged: (listener: () => void) => { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } }));
let node: HTMLDivElement, root: Root;
function Editor({ dirty = true, busy = false }: { dirty?: boolean; busy?: boolean }) {
  const leave = useSettingsLeave(), [gone, setGone] = useState(false);
  useSettingsEdit('Test configuration', !gone && dirty, !gone && busy);
  return <><p>{gone ? 'Left editor' : 'Editing'}</p><button onClick={() => leave(() => setGone(true))}>Navigate</button></>;
}
async function render(dirty = true, busy = false) { await act(async () => root.render(<SettingsEditBoundary><Editor dirty={dirty} busy={busy} /></SettingsEditBoundary>)); }
async function click(text: string) { await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === text)!.click()); }
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(() => { act(() => root.unmount()); node.remove(); runtime.listeners.clear(); });

it('leaves a clean editor immediately without a discard prompt', async () => {
  await render(false); await click('Navigate'); expect(node.textContent).toContain('Left editor'); expect(node.querySelector('dialog')).toBeNull();
});
it('keeps the editor on Escape, restores focus, and only executes the accepted transition', async () => {
  await render(); node.querySelector('button')!.focus(); await click('Navigate');
  expect(document.activeElement?.textContent).toBe('Keep editing');
  await act(async () => node.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(node.textContent).toContain('Editing'); expect(document.activeElement?.textContent).toBe('Navigate');
  await click('Navigate'); await click('Discard changes'); expect(node.textContent).toContain('Left editor');
});
it('blocks leaving a publication whose result has not been confirmed', async () => {
  await render(false, true); await click('Navigate'); expect(node.textContent).toContain('check the save outcome');
  expect([...node.querySelectorAll('button')].some(button => button.textContent === 'Discard changes')).toBe(false);
  await click('Keep editing'); await render(false, false); await click('Navigate'); expect(node.textContent).toContain('Left editor');
});
it('clears queued navigation when the runtime changes', async () => {
  await render(); await click('Navigate'); await act(async () => { for (const listener of runtime.listeners) listener(); });
  expect(node.querySelector('dialog')).toBeNull(); expect(node.textContent).toContain('Editing');
});
it('rechecks publication state before accepting an already-open discard decision', async () => {
  await render(); await click('Navigate'); await render(true, true); await click('Discard changes');
  expect(node.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  expect(node.textContent).toContain('Operation in progress'); expect(node.textContent).not.toContain('Left editor');
});
it('supports roving tab focus and protects a draft when keyboard navigation would replace its owner', async () => {
  function Tabs() {
    const [selected, setSelected] = useState('a'); useSettingsEdit('Tab draft', selected === 'a');
    return <SettingsTabs label="Sections" items={[{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }]} value={selected} onChange={setSelected} />;
  }
  await act(async () => root.render(<SettingsEditBoundary><Tabs /></SettingsEditBoundary>));
  const tabs = [...node.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1]);
  await act(async () => { tabs[0]!.focus(); tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  await click('Keep editing'); expect(tabs[0]!.getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(tabs[0]);
  await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  await click('Discard changes'); expect(tabs[1]!.getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(tabs[1]);
  await act(async () => tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
});
it('warns on browser unload only while an edit exists and unregisters when its owner unmounts', async () => {
  await render(); const first = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(first); expect(first.defaultPrevented).toBe(true);
  await act(async () => root.render(<SettingsEditBoundary><p>Clean</p></SettingsEditBoundary>));
  const next = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(next); expect(next.defaultPrevented).toBe(false);
});
