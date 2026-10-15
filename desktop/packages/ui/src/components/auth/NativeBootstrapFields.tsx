// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../lib/runtime-switch.ts';
import { markGateAuthenticated, readJsonRecord, type SessionGateRuntime } from '../../lib/sessionAuthGateState.ts';
import type { GateText } from './gateText.ts';
import { clearCachedUrlAuthToken, setRuntimeBearerToken } from '../../lib/runtime-auth.ts';
import { consumeNativeBrowserLaunch, peekNativeBrowserLaunch } from '../../lib/native-browser-launch.ts';
import { getApiBaseUrl } from '../../lib/runtime-url.ts';

interface Props { runtime: SessionGateRuntime; text: GateText; onAuthenticated(): Promise<void> }

export async function redeemNativeBootstrap(runtime: SessionGateRuntime, ticket: string, signal: AbortSignal): Promise<boolean> {
  const key = getRuntimeKey();
  const response = await runtime.fetch('/auth/native-bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }), signal,
  });
  if (!response.ok || (await readJsonRecord(response))?.authenticated !== true) return false;
  if (signal.aborted || key !== getRuntimeKey()) return false;
  setRuntimeBearerToken(null);
  clearCachedUrlAuthToken();
  // Invariant: a redemption response alone does not prove the browser accepted its cookie.
  const probe = await runtime.fetch('/auth/session', { signal });
  return probe.ok && (await readJsonRecord(probe))?.authenticated === true;
}

function useBootstrapForm({ runtime, onAuthenticated }: Props) {
  const [ticket, setTicket] = useState(() => peekNativeBrowserLaunch(getApiBaseUrl()));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    consumeNativeBrowserLaunch(getApiBaseUrl());
    const cancel = (): void => { generation.current += 1; active.current?.abort(); active.current = null; };
    const off = onRuntimeEndpointChanged(() => { cancel(); setTicket(''); setBusy(false); setFailed(false); });
    return () => { off(); cancel(); };
  }, [runtime]);
  const submit = async (): Promise<void> => {
    if (active.current || !ticket.trim()) return;
    const controller = new AbortController();
    const mine = generation.current, key = getRuntimeKey();
    active.current = controller;
    setBusy(true); setFailed(false);
    const value = ticket.trim();
    setTicket('');
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const accepted = await redeemNativeBootstrap(runtime, value, controller.signal);
      if (generation.current !== mine || key !== getRuntimeKey() || controller.signal.aborted) return;
      if (!accepted) { setFailed(true); return; }
      markGateAuthenticated();
      await onAuthenticated();
    } catch {
      if (generation.current === mine && key === getRuntimeKey()) setFailed(true);
    } finally {
      clearTimeout(timeout);
      if (generation.current === mine) { active.current = null; setBusy(false); }
    }
  };
  return { ticket, setTicket, busy, failed, submit };
}

export function NativeBootstrapFields(props: Props): ReactNode {
  const model = useBootstrapForm(props), { text } = props;
  return <div className="mt-3" data-testid="gate-native-bootstrap">
    <label className="block text-xs text-muted-foreground" htmlFor="native-bootstrap-code">{text.nativeCodeLabel}</label>
    <p id="native-bootstrap-help" className="mt-1 text-xs text-muted-foreground">{text.nativeCodeHelp}</p>
    <input id="native-bootstrap-code" type="password" autoComplete="off" maxLength={128}
      aria-describedby="native-bootstrap-help" value={model.ticket} disabled={model.busy}
      onChange={(event) => model.setTicket(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void model.submit(); } }}
      className="mt-1 w-full rounded-md border border-border/60 bg-transparent px-3 py-2 text-sm" />
    {model.failed ? <p role="alert" className="mt-2 text-xs text-destructive">{text.nativeCodeRejected}</p> : null}
    <button type="button" disabled={model.busy || !model.ticket.trim()} onClick={() => { void model.submit(); }}
      className="mt-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
      {model.busy ? text.unlocking : text.unlock}
    </button>
  </div>;
}
