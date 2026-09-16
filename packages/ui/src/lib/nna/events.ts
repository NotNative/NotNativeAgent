/**
 * SSE subscriptions for header-less transports, riding HP-8 URL tokens.
 * Harness stream: /api/event · Control stream: /api/notnative/events.
 * Browser EventSource auto-reconnects; full resume/dedupe semantics belong to
 * the sync engine (P2/doc 04).
 */
import { acquireRuntimeUrlAuthToken, appendAuthTokenToUrl } from '../runtime-auth.ts';
import { getRealtimeBaseUrl } from '../runtime-url.ts';

export interface HarnessEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
  directory?: string;
}

export type HarnessEventListener = (event: HarnessEvent) => void;

/**
 * §5.1: global frames carry `{directory, payload:{id,type,properties}}`;
 * directory streams also accept the bare payload form.
 */
export function unwrapEventFrame(raw: unknown): HarnessEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.payload && typeof record.payload === 'object') {
    const payload = record.payload as Record<string, unknown>;
    return {
      id: typeof payload.id === 'string' ? payload.id : undefined,
      type: String(payload.type ?? ''),
      properties: (payload.properties ?? {}) as Record<string, unknown>,
      directory: typeof record.directory === 'string' ? record.directory : undefined,
    };
  }
  if (typeof record.type === 'string') {
    return {
      id: typeof record.id === 'string' ? record.id : undefined,
      type: record.type,
      properties: (record.properties ?? {}) as Record<string, unknown>,
      directory: typeof record.directory === 'string' ? record.directory : undefined,
    };
  }
  return null;
}

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
      const event = unwrapEventFrame(JSON.parse(message.data));
      if (event) onEvent(event);
    } catch {
      /* opaque frames (comments, unknown shapes) pass silently */
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
