// SPDX-License-Identifier: Apache-2.0
/** Local preview server readiness probe, independent of the browser guest. */
import { useEffect, useState } from 'react';
import { isLoopbackPreview } from './preview-url.ts';

export type Readiness = { key: string; state: 'checking' | 'ready' | 'timed-out' | 'unavailable' };

export function usePreviewReadiness(active: string | null, reload: number, visible: boolean, localRuntime: boolean): Readiness | null {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const key = `${active ?? ''}|${reload}`;
  useEffect(() => {
    if (!active || !visible || !localRuntime || !isLoopbackPreview(active)) {
      setReadiness(null);
      return;
    }
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const started = Date.now();
    const deadlineTimer = setTimeout(() => {
      closed = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      setReadiness({ key, state: 'timed-out' });
    }, 30_000);
    setReadiness({ key, state: 'checking' });
    const probe = async (): Promise<void> => {
      try {
        const response = await fetch('/api/system/probe-url', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: active }), signal: controller.signal });
        if (!response.ok) throw new Error('probe unavailable');
        const result = await response.json() as { ok?: unknown; status?: unknown };
        if (closed) return;
        if (result.ok === true) {
          if (!Number.isInteger(result.status) || (result.status as number) < 200
            || (result.status as number) >= 600) throw new Error('invalid probe response');
          if ((result.status as number) < 500 || Date.now() - started >= 20_000) {
            clearTimeout(deadlineTimer);
            setReadiness({ key, state: 'ready' });
            return;
          }
        } else if (result.ok !== false) throw new Error('invalid probe response');
      } catch {
        if (closed) return;
        clearTimeout(deadlineTimer);
        setReadiness({ key, state: 'unavailable' });
        return;
      }
      retryTimer = setTimeout(() => { void probe(); }, 2000);
    };
    void probe();
    return () => {
      closed = true;
      controller.abort();
      clearTimeout(deadlineTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [active, key, localRuntime, visible]);
  return readiness;
}
