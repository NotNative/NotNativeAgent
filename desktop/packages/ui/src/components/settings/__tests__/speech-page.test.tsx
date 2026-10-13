// SPDX-License-Identifier: Apache-2.0
/** W-114 speech page: voices list, speak result, honest STT availability. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SpeechPage } from '../pages/speech.tsx';
import { useI18n } from '../../I18nProvider.tsx';

const { runtimeFetchState } = vi.hoisted(() => ({ runtimeFetchState: { impl: (..._args: unknown[]): Promise<Response> => Promise.resolve(new Response('{}')) } }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetchState.impl(...args) }));
vi.mock('../../../lib/runtime-url.ts', () => ({ getApiBaseUrl: () => 'http://runtime.test' }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('speech page (W-114)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
  afterEach(() => {
    if (container !== null && root !== null) { const r = root; root = null; act(() => { r.unmount(); }); }
    container?.remove(); container = null; vi.restoreAllMocks();
  });

  function mount(): HTMLDivElement {
    const target = container!;
    root = createRoot(target);
    act(() => root!.render(<SpeechPage />));
    return target;
  }

  it('lists local voices and reports the spoken result', async () => {
    runtimeFetchState.impl = async (...args: unknown[]) => {
      const url = String(args[0]);
      const method = (args[1] as RequestInit | undefined)?.method ?? 'GET';
      if (url.includes('/voices') && method === 'GET') return jsonResponse({ voices: [{ id: 'Zira', name: 'Microsoft Zira', culture: 'en-US', gender: 'Female' }] });
      if (url.includes('/speak') && method === 'POST') return jsonResponse({ spoken: true });
      throw new TypeError('unexpected');
    };
    const node = mount();
    await act(async () => { (node.querySelector('[data-testid="speech-voices"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="speech-voice-list"]')?.textContent).toContain('Microsoft Zira');
    });
    await act(async () => {
      const input = node.querySelector('[data-testid="speech-text"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Hello operator');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (node.querySelector('[data-testid="speech-speak"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="speech-spoken"]')?.textContent).toContain('Spoken');
    });
  });

  it('STT availability is honest: ready when the engine answers, closed when it does not', async () => {
    let sttResponse = jsonResponse({ text: '' });
    runtimeFetchState.impl = async (...args: unknown[]) => String(args[0]).includes('/transcribe') ? sttResponse : Promise.reject(new TypeError('no'));
    const node = mount();
    await act(async () => { (node.querySelector('[data-testid="stt-probe"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="stt-ready"]')?.textContent).toContain('Local recognizer available');
    });
    sttResponse = jsonResponse({ error: 'unavailable', code: 'stt-local-unavailable' }, 409);
    await act(async () => { (node.querySelector('[data-testid="stt-probe"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="stt-unavailable"]')?.textContent).toContain('stt-local-unavailable');
    });
    void useI18n; // imported to keep the provider tree type in sync
  });
});
