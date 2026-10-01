// SPDX-License-Identifier: Apache-2.0
import { runtimeFetch } from './runtime-fetch.ts';
import { pushBadge } from './browser-badge.ts';
import type { PushBadge } from './api/push-types.ts';

export async function sessionNotificationReceipt(sessionId: string, action: 'view' | 'unview' | 'message-sent', body: Record<string, unknown> = {}): Promise<{ badge?: PushBadge }> {
  const response = await runtimeFetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: 'POST', credentials: 'include', keepalive: true, signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Session receipt failed (${response.status})`);
  const reply = await response.json() as { success?: unknown; sessionId?: unknown; viewed?: unknown; messageSent?: unknown; badge?: unknown };
  if (!reply || reply.success !== true || reply.sessionId !== sessionId
    || (action === 'message-sent' ? reply.messageSent !== true : reply.viewed !== (action === 'view'))) throw new Error('Session receipt was not confirmed');
  const badge = reply.badge === undefined ? undefined : pushBadge(reply.badge);
  if (badge === null || action !== 'unview' && !badge) throw new Error('Session badge reset was not confirmed');
  return badge ? { badge } : {};
}
