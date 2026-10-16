// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';

export const nativeObservationScope = () => `${getRuntimeKey()}|${getApiBaseUrl()}`;
export function useNativeObservation<T>(read: (signal: AbortSignal) => Promise<T>, automatic = true) {
  const scope = useSyncExternalStore(onRuntimeEndpointChanged, nativeObservationScope);
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const ready = auth === 'ok' && authority === 'ready';
  const reload = useCallback(async () => {
    if (!ready || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    const current = () => !controller.signal.aborted && pending.current === controller && scope === nativeObservationScope()
      && useAuthSessionStore.getState().status === 'ok' && authorityState() === 'ready';
    setBusy(true); setError(null);
    try { const value = await read(controller.signal); if (current()) setData(value); }
    catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : 'Native operation failed.'); }
    finally { if (current()) { pending.current = null; setBusy(false); } }
  }, [read, ready, scope]);
  useEffect(() => {
    setData(null); setError(null); setBusy(false);
    if (automatic) void reload();
    return () => { pending.current?.abort(); pending.current = null; };
  }, [reload, automatic]);
  return { data, error, busy, ready, reload };
}
