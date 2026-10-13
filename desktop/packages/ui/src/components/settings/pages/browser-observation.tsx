// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readNativeBrowserStatus, verifyNativeBrowser, browserMessages,
  type NativeBrowserReceipt } from '../../../lib/nnd/browser.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => browserMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';
const toSentence = (value: unknown) => messageFor(isNativeFailure(value) ? value.code
  : 'nnd_browser_action_unavailable');

function useBrowserReceipt() {
  const [receipt, setReceipt] = useState<NativeBrowserReceipt | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const run = useCallback(async (kind: 'status' | 'verify') => {
    if (pending.current || authorityState() !== 'ready'
      || useAuthSessionStore.getState().status !== 'ok') return;
    const controller = new AbortController(); pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setBusy(true); setError(null);
    try {
      const next = kind === 'status' ? await readNativeBrowserStatus(controller.signal)
        : await verifyNativeBrowser(controller.signal);
      if (current()) setReceipt(next);
    } catch (failure) { if (current()) setError(toSentence(failure)); }
    finally { if (current()) { pending.current = null; setBusy(false); } }
  }, []);
  useEffect(() => {
    const reset = () => {
      pending.current?.abort(); pending.current = null;
      setReceipt(null); setBusy(false); setError(null);
    };
    reset();
    const unsubscribe = onRuntimeEndpointChanged(reset);
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, []);
  return { receipt, busy, error, run };
}

export function BrowserObservationPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const { receipt, busy, error, run } = useBrowserReceipt();
  const started = useRef(false);
  useEffect(() => {
    if (auth === 'ok' && authority === 'ready' && !started.current) {
      started.current = true; void run('status');
    }
    if (auth !== 'ok') started.current = false;
  }, [auth, authority, run]);
  const disabled = busy || auth !== 'ok' || authority !== 'ready';
  return <SettingsSection item="native-browser.observation">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Managed browser</SettingsGroupTitle>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" disabled={disabled}
          onClick={() => { void run('status'); }}>Read status</button>
        <button type="button" className="btn-secondary" disabled={disabled} data-testid="browser-verify"
          onClick={() => { void run('verify'); }}>Verify with launch probe</button>
      </div>
    </div>
    <p className="text-xs text-muted-foreground">The managed Playwright Chromium the webbrowse tool
      loads, read through the native authority; the verify action launches headless Chromium, renders
      a validation page, and closes it — nothing on disk changes.</p>
    {auth !== 'ok' ? <p role="status">Sign in to read the managed browser observation.</p> : null}
    {authority !== 'ready' ? <p role="status">Native authority is resynchronizing; reading is paused.</p> : null}
    {error ? <p role="alert" data-testid="browser-error">{error}</p> : null}
    {receipt ? <ReceiptView receipt={receipt} /> : null}
  </SettingsSection>;
}

function ReasonRow({ reason }: { reason: string | null }): ReactNode {
  return reason === null ? null : <><dt>Reason</dt><dd>{messageFor(reason)}</dd></>;
}

function ReceiptView({ receipt }: { receipt: NativeBrowserReceipt }): ReactNode {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs" data-testid="browser-receipt">
    <dt>Action</dt><dd>{receipt.action}</dd>
    <dt>Available</dt><dd>{receipt.status.available ? 'yes' : 'no'}</dd>
    <dt>Version</dt><dd>{receipt.status.version ?? '—'}</dd>
    <ReasonRow reason={receipt.status.reason} />
    <dt>Browser path</dt><dd>{receipt.status.browser_path ?? '—'}</dd>
  </dl>;
}
