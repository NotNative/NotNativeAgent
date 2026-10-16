// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestNativeConfiguration, type NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';

export function useAgentConfiguration() {
  const auth = useAuthSessionStore(state => state.status);
  const [view, setView] = useState<NativeConfigurationView | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (pending.current || auth !== 'ok') return;
    const controller = new AbortController(); pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setLoading(true); setError(false); setView(null);
    try { const result = await requestNativeConfiguration(controller.signal); if (current()) setView(result); }
    catch { if (current()) setError(true); }
    finally { if (current()) { pending.current = null; setLoading(false); } }
  }, [auth]);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null; setView(null); setLoading(false); setError(false); };
    reset(); void load();
    const unsubscribe = onRuntimeEndpointChanged(() => { reset(); void load(); });
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [load]);
  return { view, loading, error, load, authorized: auth === 'ok' };
}
