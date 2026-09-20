// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * PairingDialog (doc 08 §6.1 + §5.8/§5.10), mounted for real: the reducer, the
 * watcher, the QR encode, the countdown and the clipboard all run. The outside
 * world arrives through the dialog's own seams — an injected `PairingRuntime`
 * whose `fetch` is a route-scripted stub, plus `renderQr`, `isVisible`, `now`
 * and `writeClipboard` — so this file needs no module mocks at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PairingDialog, type PairingDialogProps } from '../PairingDialog.tsx';
import {
  createPairingRuntime,
  type PendingPairingRow,
  type PairingRuntime,
  type RemoteClientRow,
} from '../../../lib/pairing-client.ts';
import {
  parseConnectionPayload,
  PAIRING_LINK_PREFIX,
} from '../../../lib/connection-payload.ts';
import type { PairingCloseReason } from '../../../lib/pairing-watch.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Anchored to the real clock: the §5.1 validator rejects a payload whose
 * `expiresAt` has passed against `Date.now()`, and the create reply is fed
 * through that same validator when the dialog encodes its link.
 */
const NOW = Date.now();
const HOUR_LATER = new Date(NOW + 3_600_000).toISOString();

function pendingRow(id: string, overrides: Partial<PendingPairingRow> = {}): PendingPairingRow {
  return {
    id,
    label: 'Phone',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: HOUR_LATER,
    usedAt: null,
    cancelledAt: null,
    clientId: null,
    fingerprint: 'C'.repeat(43),
    allowedClientKinds: ['mobile', 'desktop'],
    createdByClientId: null,
    usesRelay: false,
    ...overrides,
  };
}

function clientRow(id: string, overrides: Partial<RemoteClientRow> = {}): RemoteClientRow {
  return {
    id,
    label: 'Phone',
    createdAt: new Date(NOW).toISOString(),
    lastUsedAt: new Date(NOW).toISOString(),
    revokedAt: null,
    clientKind: 'mobile',
    usesRelay: false,
    lastTransport: 'direct',
    pairingId: 'pair_1',
    ...overrides,
  };
}

const CREATED_PAIRING = {
  id: 'pair_1',
  // The create reply carries the one-time pairing secret; the link is the only
  // place it may appear (§5.2), so the fixture value is arbitrary here.
  secret: `pairing-fixture-${'S'.repeat(16)}`,
  createdAt: new Date(NOW).toISOString(),
  expiresAt: HOUR_LATER,
  usedAt: null,
  cancelledAt: null,
  clientId: null,
  label: 'Phone',
  fingerprint: 'B'.repeat(43),
  allowedClientKinds: ['mobile', 'desktop'],
  createdByClientId: null,
  usesRelay: true,
};

const SERVER = {
  label: 'workstation',
  candidates: [
    { type: 'lan', url: 'http://192.168.1.20:3000', priority: 10 },
    {
      type: 'relay',
      relayUrl: 'wss://relay.example.test/ws',
      serverId: 'srv_1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' },
      grant: 'Z3JhbnRkZW1v',
      priority: 30,
    },
  ],
};

type Answer = { status?: number; body?: unknown };
type Route = { method: string; matches: RegExp; answers: Answer[] };
type StubCall = { method: string; url: string; body: string };

/**
 * Answers keyed by method + path. Answers are consumed in order per route and
 * the last one repeats, so an extra poll behaves like a real server instead of
 * throwing. `GET /pairing/sessions` is asked by the dialog *and* by the
 * watcher, so the scripts below count both.
 */
function stubServer(
  routes: Route[],
  clock: () => number = () => NOW,
): { runtime: PairingRuntime; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const taken = new Map<Route, number>();
  const fetch = async (
    input: string | Request,
    init?: { method?: string; body?: string },
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init?.method ?? 'GET').toUpperCase();
    const path = new URL(url, 'http://localhost:3000').pathname;
    calls.push({ method, url, body: init?.body ?? '' });
    const route = routes.find((entry) => entry.method === method && entry.matches.test(path));
    if (route === undefined) return new Response('not stubbed', { status: 500 });
    const index = Math.min(taken.get(route) ?? 0, route.answers.length - 1);
    taken.set(route, index + 1);
    const answer = route.answers[index] ?? {};
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    runtime: createPairingRuntime({
      fetch: fetch as unknown as PairingRuntime['fetch'],
      now: clock,
    }),
    calls,
  };
}

const TRANSPORTS: Answer = {
  body: {
    local: 'http://127.0.0.1:3000',
    lan: 'http://192.168.1.20:3000',
    relayAvailable: true,
  },
};

function createdAnswer(expiresAt: string = HOUR_LATER): Answer {
  return { body: { pairing: { ...CREATED_PAIRING, expiresAt }, server: SERVER } };
}

function pendingAnswer(...rows: PendingPairingRow[]): Answer {
  return { body: { pending: rows } };
}

function clientsAnswer(...rows: RemoteClientRow[]): Answer {
  return { body: { clients: rows } };
}

function routeScript(
  overrides: Partial<Record<'transports' | 'create' | 'pending' | 'clients', Answer[]>> = {},
): Route[] {
  return [
    {
      method: 'GET',
      matches: /^\/api\/client-auth\/pairing\/transports$/,
      answers: overrides.transports ?? [TRANSPORTS],
    },
    {
      method: 'POST',
      matches: /^\/api\/client-auth\/pairing\/sessions$/,
      answers: overrides.create ?? [createdAnswer()],
    },
    {
      method: 'GET',
      matches: /^\/api\/client-auth\/pairing\/sessions$/,
      answers: overrides.pending ?? [pendingAnswer()],
    },
    {
      method: 'GET',
      matches: /^\/api\/client-auth\/clients$/,
      answers: overrides.clients ?? [clientsAnswer()],
    },
    {
      method: 'DELETE',
      matches: /^\/api\/client-auth\/pairing\/sessions\//,
      answers: [{ body: { cancelled: true } }],
    },
  ];
}

let root: Root | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

/** Real time, for the watcher's timer-driven cadence. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(props: PairingDialogProps): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<PairingDialog {...props} />);
  });
  await settle();
  return host;
}

function byTestId(host: HTMLElement, id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}

function textOf(host: HTMLElement, id: string): string {
  return byTestId(host, id)?.textContent ?? '';
}

async function click(element: HTMLElement | null): Promise<void> {
  if (element === null) throw new Error('expected an element to click');
  await act(async () => {
    element.click();
  });
  await settle();
}

/** The create button is a form submit; jsdom form submission is dispatched directly. */
async function submitForm(host: HTMLElement): Promise<void> {
  const form = host.querySelector('form');
  if (form === null) throw new Error('no pairing form rendered');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function dialogProps(
  runtime: PairingRuntime,
  overrides: Partial<PairingDialogProps> = {},
): PairingDialogProps {
  return {
    open: true,
    runtime,
    renderQr: async () => 'data:image/png;base64,QRTEST',
    pollIntervalMs: 5,
    now: () => NOW,
    onClose: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  act(() => {
    root?.unmount();
    root = null;
  });
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// §6.1 steps 1-2 — transports, scope plan, pending list
// ---------------------------------------------------------------------------

describe('PairingDialog scope form', () => {
  it('renders nothing while open is false: no overlay and not one route call', async () => {
    // The dialog is driven entirely by `open` (§6.1): a closed dialog holds no
    // poller, no timer, and no overlay — the hooks run (they reset the model)
    // but nothing may reach the screen or the wire.
    const { runtime, calls } = stubServer(routeScript());
    const host = await mount(dialogProps(runtime, { open: false }));
    expect(host.textContent).toBe('');
    expect(host.querySelector('[data-testid="pairing-dialog"]')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('opens on the form with the server transport picture and an empty pending list', async () => {
    const { runtime } = stubServer(routeScript());
    const host = await mount(dialogProps(runtime));
    expect(byTestId(host, 'pairing-create')).not.toBeNull();
    expect((byTestId(host, 'pairing-create') as HTMLButtonElement).disabled).toBe(false);
    expect(host.textContent).toContain('No pending pairings.');
    expect(byTestId(host, 'pairing-result')).toBeNull();
  });

  it('says pairing is off and blocks create when pairingAvailable is false', async () => {
    const { runtime } = stubServer(routeScript());
    const host = await mount(dialogProps(runtime, { pairingAvailable: false }));
    expect(byTestId(host, 'pairing-disabled')).not.toBeNull();
    expect((byTestId(host, 'pairing-create') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses an unhonourable plan and names the fix (§6.1 step 2)', async () => {
    const { runtime, calls } = stubServer(
      routeScript({
        transports: [
          {
            body: {
              local: 'http://127.0.0.1:3000',
              lan: 'http://192.168.1.20:3000',
              relayAvailable: false,
            },
          },
        ],
      }),
    );
    const host = await mount(dialogProps(runtime));
    // Default scope is "anywhere" with the fallback checked: LAN-only is fine.
    expect(byTestId(host, 'pairing-refusal')).toBeNull();
    const relay = host.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (relay === null) throw new Error('no relay fallback checkbox');
    await click(relay);
    expect(textOf(host, 'pairing-refusal')).toContain('The encrypted relay is off');
    expect((byTestId(host, 'pairing-create') as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('lists a pending session and cancels it from the form (§6.1 step 8)', async () => {
    const { runtime, calls } = stubServer(
      routeScript({ pending: [pendingAnswer(pendingRow('p9', { usesRelay: true }))] }),
    );
    const host = await mount(dialogProps(runtime));
    expect(byTestId(host, 'pairing-pending-row')).not.toBeNull();
    expect(host.textContent).toContain('via Relay');
    await click(byTestId(host, 'pairing-cancel-pending'));
    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.url).toBe('/api/client-auth/pairing/sessions/p9');
  });
});

// ---------------------------------------------------------------------------
// §6.1 steps 3-4 + §5.8 — create, QR, manual link
// ---------------------------------------------------------------------------

describe('PairingDialog result', () => {
  it('creates a pairing and renders the §5.8 QR next to the printable link', async () => {
    const { runtime, calls } = stubServer(routeScript());
    const host = await mount(dialogProps(runtime));
    await submitForm(host);
    expect(byTestId(host, 'pairing-result')).not.toBeNull();
    const qr = byTestId(host, 'pairing-qr');
    expect(qr).not.toBeNull();
    expect(qr?.getAttribute('src')).toBe('data:image/png;base64,QRTEST');
    expect(qr?.getAttribute('data-qr-size')).toBe('1024');
    expect(qr?.getAttribute('data-qr-error-level')).toBe('L');
    expect(textOf(host, 'pairing-server-label')).toBe('workstation');
    const link = textOf(host, 'pairing-link');
    expect(link.startsWith(PAIRING_LINK_PREFIX)).toBe(true);
    const parsed = parseConnectionPayload(link);
    expect(parsed.status).toBe('pairing');
    if (parsed.status !== 'pairing') return;
    expect(parsed.payload.pairingId).toBe('pair_1');
    expect(parsed.payload.label).toBe('workstation');
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toContain('allowedClientKinds');
  });

  it('keeps a copyable link when the QR cannot be rendered (§5.10)', async () => {
    const { runtime } = stubServer(routeScript());
    const host = await mount(dialogProps(runtime, { renderQr: null }));
    await submitForm(host);
    expect(byTestId(host, 'pairing-qr')).toBeNull();
    expect(textOf(host, 'pairing-qr-placeholder')).toContain('QR unavailable');
    expect(textOf(host, 'pairing-error')).toContain('QR rendering is unavailable');
    expect(textOf(host, 'pairing-link')).toContain(PAIRING_LINK_PREFIX);
  });

  it('copies exactly the link the panel printed (§6.1 step 10)', async () => {
    const written: string[] = [];
    const { runtime } = stubServer(routeScript());
    const host = await mount(
      dialogProps(runtime, {
        writeClipboard: async (value: string) => {
          written.push(value);
        },
      }),
    );
    await submitForm(host);
    await click(byTestId(host, 'pairing-copy'));
    expect(written).toEqual([textOf(host, 'pairing-link')]);
    expect(textOf(host, 'pairing-copy')).toEqual('Copied');
  });

  it('reports a clipboard refusal instead of pretending the copy worked', async () => {
    const { runtime } = stubServer(routeScript());
    const host = await mount(
      dialogProps(runtime, {
        writeClipboard: async () => {
          throw new Error('blocked by the browser');
        },
      }),
    );
    await submitForm(host);
    await click(byTestId(host, 'pairing-copy'));
    expect(textOf(host, 'pairing-copy-failed')).toContain('Copy failed');
  });

  it('shows the server refusal text and stays on the form', async () => {
    const { runtime } = stubServer(
      routeScript({
        create: [{ status: 503, body: { error: 'Relay fallback requested but unavailable' } }],
      }),
    );
    const host = await mount(dialogProps(runtime));
    await submitForm(host);
    expect(textOf(host, 'pairing-error')).toContain('Relay fallback requested but unavailable');
    expect(byTestId(host, 'pairing-result')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §6.1 steps 5/8/9 — the watcher, cancellation, auto-close
// ---------------------------------------------------------------------------

describe('PairingDialog watcher', () => {
  /** Open refresh, post-create refresh, then the watcher's own polls. */
  function pendingScript(first: PendingPairingRow, then: PendingPairingRow[]): Answer[] {
    return [pendingAnswer(), pendingAnswer(first), pendingAnswer(first), pendingAnswer(...then)];
  }

  it('auto-closes as redeemed once a live client row carries the pairing', async () => {
    const finished: PairingCloseReason[] = [];
    const connected: string[] = [];
    let closes = 0;
    const { runtime } = stubServer(
      routeScript({
        pending: pendingScript(pendingRow('pair_1'), []),
        clients: [clientsAnswer(), clientsAnswer(clientRow('client_1'))],
      }),
    );
    const host = await mount(
      dialogProps(runtime, {
        onFinished: (reason) => {
          finished.push(reason);
        },
        onConnected: (id) => {
          connected.push(id);
        },
        onClose: () => {
          closes += 1;
        },
      }),
    );
    await submitForm(host);
    await wait(120);
    expect(finished).toEqual(['redeemed']);
    expect(connected).toEqual(['client_1']);
    expect(closes).toBe(1);
    expect(textOf(host, 'pairing-close-reason')).toContain('Device connected');
  });

  it('a pending row that vanishes before expiry closes as cancelled', async () => {
    const finished: PairingCloseReason[] = [];
    const { runtime } = stubServer(
      routeScript({ pending: pendingScript(pendingRow('pair_1'), []), clients: [clientsAnswer()] }),
    );
    const host = await mount(
      dialogProps(runtime, {
        autoClose: false,
        onFinished: (reason) => {
          finished.push(reason);
        },
      }),
    );
    await submitForm(host);
    await wait(120);
    expect(finished).toEqual(['cancelled']);
    expect(textOf(host, 'pairing-close-reason')).toContain('Pairing cancelled');
  });

  it('a pending row that vanishes after expiry closes as expired', async () => {
    const finished: PairingCloseReason[] = [];
    const later = NOW + 4_000_000;
    const { runtime } = stubServer(
      routeScript({ pending: pendingScript(pendingRow('pair_1'), []), clients: [clientsAnswer()] }),
      () => later,
    );
    const host = await mount(
      dialogProps(runtime, {
        autoClose: false,
        now: () => later,
        onFinished: (reason) => {
          finished.push(reason);
        },
      }),
    );
    await submitForm(host);
    await wait(120);
    expect(finished).toEqual(['expired']);
    expect(textOf(host, 'pairing-expired')).toContain('This code has expired');
  });

  it('a hidden page never polls for the redemption (§6.1 step 5)', async () => {
    const { runtime, calls } = stubServer(routeScript());
    const host = await mount(dialogProps(runtime, { isVisible: () => false }));
    await submitForm(host);
    await wait(60);
    expect(calls.filter((call) => call.url.includes('/api/client-auth/clients'))).toHaveLength(0);
    expect(byTestId(host, 'pairing-close-reason')).toBeNull();
  });

  it('closing a live pairing cancels it server-side (§6.1 step 9)', async () => {
    const finished: PairingCloseReason[] = [];
    const { runtime, calls } = stubServer(routeScript());
    const host = await mount(
      dialogProps(runtime, {
        onFinished: (reason) => {
          finished.push(reason);
        },
      }),
    );
    await submitForm(host);
    await click(byTestId(host, 'pairing-close'));
    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.url).toBe('/api/client-auth/pairing/sessions/pair_1');
    expect(finished).toEqual(['cancelled']);
  });
});
