// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { captureNativeBrowserLaunch, consumeNativeBrowserLaunch, peekNativeBrowserLaunch } from '../native-browser-launch.ts';
const code = 'a'.repeat(43);
function launch(origin = 'http://127.0.0.1:12345') {
  const url = new URL(`${origin}/#nna-access=${code}`);
  const replaceState = vi.fn((_state, _title, path: string) => { url.href = new URL(path, url).href; });
  vi.stubGlobal('window', { location: url, history: { state: null, replaceState } });
  captureNativeBrowserLaunch(); return { url, replaceState };
}
afterEach(() => { consumeNativeBrowserLaunch(''); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('scrubs a loopback launch code and hands it only to the same origin once', () => {
  const { url, replaceState } = launch();
  expect(url.hash).toBe(''); expect(replaceState).toHaveBeenCalledOnce();
  expect(peekNativeBrowserLaunch(url.origin)).toBe(code);
  expect(peekNativeBrowserLaunch(url.origin)).toBe(code);
  expect(consumeNativeBrowserLaunch(url.origin)).toBe(code);
  expect(consumeNativeBrowserLaunch(url.origin)).toBe('');
});
it('rejects remote origins and discards a code when the selected service changes', () => {
  launch('http://other:12345'); expect(consumeNativeBrowserLaunch('http://other:12345')).toBe('');
  const { url } = launch(); expect(consumeNativeBrowserLaunch('http://127.0.0.1:12346')).toBe('');
  expect(consumeNativeBrowserLaunch(url.origin)).toBe('');
});
it('does not interpret message anchors as credentials or retain expired codes', () => {
  const { url } = launch(); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
  expect(consumeNativeBrowserLaunch(url.origin)).toBe('');
  url.hash = '#message-existing'; captureNativeBrowserLaunch();
  expect(url.hash).toBe('#message-existing');
});
