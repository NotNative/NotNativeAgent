// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ key: 'local', available: true, listener: () => {},
  subscribed: vi.fn(), enable: vi.fn(), disable: vi.fn(),
}));
vi.mock('../../../../lib/browser-push.ts', () => ({
  browserPushAvailable: () => fixture.available, browserPushSubscribed: fixture.subscribed,
  enableBrowserPush: fixture.enable, disableBrowserPush: fixture.disable,
}));
vi.mock('../../../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => fixture.key,
  onRuntimeEndpointChanged: (listener: () => void) => { fixture.listener = listener; return () => {}; },
}));
vi.mock('../../../I18nProvider.tsx', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { BrowserPushControl } from '../browser-push-control.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks(); fixture.key = 'local'; fixture.available = true;
  fixture.subscribed.mockResolvedValue(false);
  fixture.enable.mockResolvedValue(undefined); fixture.disable.mockResolvedValue(undefined);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async () => { await act(async () => root.render(<StrictMode><BrowserPushControl /></StrictMode>)); };
const click = async (label: string) => {
  await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label)!.click());
};
const status = () => container.querySelector('[role="status"]')?.textContent;

it('distinguishes existing browser state from a server-confirmed registration', async () => {
  fixture.subscribed.mockResolvedValue(true);
  await render(); expect(status()).toBe('push.existing');
  await click('push.enable'); expect(status()).toBe('push.registered');
  await click('push.refresh'); expect(status()).toBe('push.existing');
});

it('removes the registered claim after an uncertain unsubscribe and allows retry', async () => {
  await render(); await click('push.enable'); expect(status()).toBe('push.registered');
  fixture.disable.mockRejectedValueOnce(new Error('browser removal failed after server removal'));
  await click('push.disable');
  expect(status()).toBe('push.unknown'); expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await click('push.disable'); expect(status()).toBe('push.off');
});

it('ignores an old registration acknowledgement after switching runtime', async () => {
  let finish!: () => void;
  fixture.enable.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await render(); await click('push.enable'); expect(status()).toBe('push.saving');
  await act(async () => { fixture.key = 'other'; fixture.listener(); });
  await act(async () => finish());
  expect(status()).toBe('push.off');
});

it('offers no actions for an unavailable browser', async () => {
  fixture.available = false;
  await render(); expect(container.querySelector('button')).toBeNull();
  expect(fixture.subscribed).not.toHaveBeenCalled();
});
