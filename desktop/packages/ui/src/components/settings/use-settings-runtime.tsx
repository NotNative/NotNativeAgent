// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { bindSettingsBridge } from '../../lib/settings/store.ts';
import { connectNativePreferences } from '../../lib/settings/native-preferences.ts';

/** Invariant: capability detection owns the settings connection; an unknown host cannot expose compatibility controls. */
export function useSettingsRuntime(runtimeKey: string) {
  const [state, setState] = useState({ nativeAlpha: false, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disconnect: (() => void) | undefined;
    setState({ nativeAlpha: false, status: 'loading' });
    void runtimeFetch('/health', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }).then(async response => {
      if (!response.ok) throw new Error('Runtime unavailable');
      const health = await response.json() as { runtime?: unknown };
      if (typeof health.runtime !== 'string' || !health.runtime) throw new Error('Runtime identity unavailable');
      if (controller.signal.aborted) return;
      const nativeAlpha = health.runtime === 'service';
      disconnect = nativeAlpha ? connectNativePreferences() : bindSettingsBridge();
      setState({ nativeAlpha, status: 'ready' });
    }).catch(() => { if (!controller.signal.aborted) setState({ nativeAlpha: false, status: 'error' }); });
    return () => { controller.abort(); disconnect?.(); };
  }, [runtimeKey, attempt]);
  return { ...state, retry: () => setAttempt(value => value + 1) };
}

export function PendingSettingsRuntime({ failed, retry, close }: { failed: boolean; retry(): void; close(): void }): ReactNode {
  return <div role="dialog" aria-label="Settings" className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
    <div className="max-w-md rounded-xl border border-border bg-background p-6 text-foreground shadow-xl">
      <p role={failed ? 'alert' : 'status'}>{failed ? 'Could not identify the connected runtime. Settings are unavailable until it responds.' : 'Checking settings capabilities…'}</p>
      <div className="mt-4 flex justify-end gap-4">
        {failed ? <button type="button" onClick={retry}>Retry settings connection</button> : null}
        <button type="button" onClick={close}>Close settings</button>
      </div>
    </div>
  </div>;
}
