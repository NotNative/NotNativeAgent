// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * App composition (doc 01 §4.3 provider tree + doc 08 §6.6): renderMainApp
 * mounts `… > SessionAuthGate > App`, so a locked visitor never boots the app
 * (no MainLayout, no engine), an authenticated one does, and the mounted layout
 * carries the §6.7 AuthExpiredBanner under the header with the §2.8 focus
 * watch installed at the App root.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// NO static imports of the app factory chain: `runtimeFetch` captures
// globalThis.fetch at module-evaluation time, so every module below must be
// imported (once) only after the fetch router is installed in `beforeAll`.
let mod: (typeof import('../../../main.tsx')) | null = null;
let authExpiry: (typeof import('../../../lib/runtime-auth-expiry.ts')) | null = null;
let renderMainApp: (typeof import('../../../main.tsx'))['renderMainApp'];

beforeAll(async () => {
  stubFetch();
  mod = await import('../../../main.tsx');
  authExpiry = await import('../../../lib/runtime-auth-expiry.ts');
  renderMainApp = mod.renderMainApp;
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Route = { pattern: RegExp; status: number; body: unknown | null; stream: boolean };

let routes: Route[] = [];

function liveSession(): Route {
  return {
    pattern: /^\/auth\/session$/,
    status: 200,
    body: { authenticated: true, scope: 'open', authRequired: false, methods: ['password'] },
    stream: false,
  };
}

function lockedSession(): Route {
  return {
    pattern: /^\/auth\/session$/,
    status: 401,
    body: { authenticated: false, locked: true, methods: ['password'] },
    stream: false,
  };
}

/** A stream that answers 200 and never yields body bytes nor closes. */
function pendingStream(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() { /* held open */ } }), { status: 200 });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchStub: ReturnType<typeof vi.fn>;

function stubFetch(): void {
  fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    const path = url.pathname;
    for (const route of routes) {
      if (!route.pattern.test(path)) continue;
      if (route.stream) return pendingStream();
      if (route.body === null) return new Response('', { status: route.status });
      return jsonResponse(route.body, route.status);
    }
    if (path === '/api/event' || path.startsWith('/api/notnative/events')) return pendingStream();
    if (path.startsWith('/api/passkeys')) return jsonResponse({ passkeys: [] }, 200);
    if (path === '/health') return jsonResponse({ planModeExperimentalEnabled: false }, 200);
    if (path.startsWith('/api/')) {
      // List-shaped harness catalogs ride arrays (command/skill/agent/provider/
      // session/project); config objects ride {}.
      const listFamily = /^\/api\/(command|skill|agent|provider|tool|session|project|model|lsp|snippet)/u;
      return jsonResponse(listFamily.test(path) ? [] : {}, 200);
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fetchStub);
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

async function mountApp(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    renderMainApp(container!);
    // Two macro turns: the gate probe, then (authenticated) the App boot.
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settleTurns(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      for (let j = 0; j < 8; j += 1) await Promise.resolve();
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    }
  });
}

beforeEach(() => {
  authExpiry!.__resetAuthExpiryForTests();
  window.localStorage.clear();
  window.history.replaceState(null, '', window.location.pathname);
  document.body.innerHTML = '';
  window.matchMedia = window.matchMedia
    ?? ((query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as typeof window.matchMedia);
  stubFetch();
});

afterEach(() => {
  try {
    act(() => rootHandle?.unmount());
  } finally {
    vi.unstubAllGlobals();
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    container?.remove();
    container = null;
    rootHandle = null;
    routes = [];
  }
});

describe('renderMainApp gate composition (doc 01 tree + §6.6)', () => {
  it('keeps the workspace sidebar mounted and opens a new conversation', async () => {
    routes = [liveSession()];
    await mountApp();
    await settleTurns();
    const sidebar = document.querySelector('[data-testid="session-sidebar"]');
    expect(sidebar).toBeTruthy();
    expect(document.querySelector('#session-sidebar-panel')?.nextElementSibling?.querySelector('[data-testid="app-header"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="Workspace tools"]')).toBeNull();
    const newSession = sidebar!.querySelector<HTMLButtonElement>('[data-testid="sidebar-new-session"]');
    expect(newSession).toBeTruthy();
    await act(async () => { newSession!.click(); });
    expect(document.querySelector('[data-testid="chat-draft-landing"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="composer-editor"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="session-sidebar"]')).toBe(sidebar);
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Toggle session sidebar"]');
    await act(async () => { toggle!.click(); });
    expect(document.querySelector('#session-sidebar-panel')?.classList.contains('hidden')).toBe(true);
    await act(async () => { toggle!.click(); });
    expect(document.querySelector('[data-testid="session-sidebar"]')).toBe(sidebar);
  });

  it('a locked visitor never mounts the app: gate screen, no header', async () => {
    routes = [lockedSession()];
    await mountApp();
    await settleTurns();
    expect(document.querySelector('[data-testid="session-auth-gate"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="app-header"]')).toBeNull();
  });

  it('an authenticated visitor mounts the app under the gate with the banner row', async () => {
    routes = [liveSession()];
    const doc = document as unknown as {
      addEventListener: (type: string, listener: unknown) => void;
      removeEventListener: (type: string, listener: unknown) => void;
    };
    const addSpy = vi.spyOn(doc, 'addEventListener');
    const removeSpy = vi.spyOn(doc, 'removeEventListener');
    await mountApp();
    await settleTurns();
    expect(document.querySelector('[data-testid="app-header"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="auth-expired-banner"]')).toBeNull();
    // §2.8 focus revalidation installed once (StrictMode symmetric, one alive).
    const focusAdds = addSpy.mock.calls.filter((call) => call[0] === 'focus');
    expect(focusAdds.length).toBeGreaterThanOrEqual(1);

    await act(() => {
      authExpiry!.useAuthSessionStore.setState({ status: 'expired' });
    });
    expect(document.querySelector('[data-testid="auth-expired-banner"]')).toBeTruthy();

    await act(() => {
      authExpiry!.useAuthSessionStore.getState().markOk();
    });
    expect(document.querySelector('[data-testid="auth-expired-banner"]')).toBeNull();

    rootHandle?.unmount();
    rootHandle = null;
    const focusRemoves = removeSpy.mock.calls.filter((call) => call[0] === 'focus');
    expect(focusRemoves.length).toBeGreaterThanOrEqual(1);
  });
});
