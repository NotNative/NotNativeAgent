// SPDX-License-Identifier: Apache-2.0
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import type { NotificationPayload } from '../../../../ui/src/sync/desktop-notifications.ts';

export async function notificationMessages(payload: NotificationPayload, signal: AbortSignal): Promise<unknown[]> {
  const response = await callHarness(harnessRequest(`/session/${encodeURIComponent(payload.sessionId)}/message?limit=8`, payload.directory,
    { method: 'GET', signal }));
  if (!response.ok || !response.body) return [];
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = '';
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 262_144) { cancel(); return []; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const rows: unknown = JSON.parse(text + decoder.decode());
    return Array.isArray(rows) ? rows.slice(-8) : [];
  } catch { return []; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Security: tool arguments/results, user messages and reasoning never enter notification generation. */
export function notificationAssistantText(rows: unknown[]): string {
  const pieces: string[] = []; let available = 6000;
  for (const raw of rows.slice(-8).reverse()) {
    const row = raw as { info?: { role?: unknown }; parts?: unknown } | null;
    if (row?.info?.role !== 'assistant' || !Array.isArray(row.parts)) continue;
    const text = row.parts.slice(0, 24).flatMap((part) => part?.type === 'text' && typeof part.text === 'string' ? [part.text.slice(0, 2048)] : []).join('\n').slice(0, available);
    if (text) { pieces.unshift(text); available -= text.length; }
    if (!available) break;
  }
  return pieces.join('\n').slice(-6000);
}
