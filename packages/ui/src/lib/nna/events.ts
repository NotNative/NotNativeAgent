/**
 * SSE subscriptions for header-less transports, riding HP-8 URL tokens.
 * Harness stream: /api/event · Control stream: /api/notnative/events.
 * Browser EventSource auto-reconnects; full resume/dedupe semantics belong to
 * the sync engine (P2/doc 04).
 */
import { acquireRuntimeUrlAuthToken, appendAuthTokenToUrl } from '../runtime-auth.ts';
import { getRealtimeBaseUrl } from '../runtime-url.ts';

export interface HarnessEvent {
  id?: number;
  type: string;
  properties?: Record<string, unknown>;
}

export type HarnessEventListener = (event: HarnessEvent) => void;

async function openStream(
  path: string,
  onEvent: HarnessEventListener,
  onReady?: () => void,
): Promise<() => void> {
  const releaseToken = acquireRuntimeUrlAuthToken();
  const url = await appendAuthTokenToUrl(`${getRealtimeBaseUrl()}${path}`);
  const source = new EventSource(url);
  source.onmessage = (message: MessageEvent) => {
    try {
      onEvent(JSON.parse(message.data) as HarnessEvent);
    } catch {
      /* opaque frames (heartbeats, unknown shapes) pass silently */
    }
  };
  if (onReady) source.onopen = () => onReady();
  return () => {
    source.close();
    releaseToken();
  };
}

/** Harness event stream (/api/event) — proxied, token-carrying. */
export function subscribeHarnessEvents(
  onEvent: HarnessEventListener,
  onReady?: () => void,
): Promise<() => void> {
  return openStream('/api/event', onEvent, onReady);
}

/** Control stream (/api/notnative/events) — server-owned synthetic events. */
export function subscribeControlEvents(
  onEvent: HarnessEventListener,
  onReady?: () => void,
): Promise<() => void> {
  return openStream('/api/notnative/events', onEvent, onReady);
}
