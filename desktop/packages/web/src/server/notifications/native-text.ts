// SPDX-License-Identifier: Apache-2.0
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import type { SmallModelPorts } from '../routes/small-model.ts';

export async function generateNativeNotification(raw: Record<string, unknown>, ports: SmallModelPorts, signal?: AbortSignal): Promise<Response> {
  const input = JSON.parse(String(raw.prompt)) as { event: string; fallback: { title: string; body: string }; assistantText: string };
  const settings: Record<string, unknown> = await (ports.settings?.() ?? {});
  // Why (uniformity #2): the per-call notification model is a desktop-local
  // choice (smallModelUseDefault stays honored; the registry override entry is
  // removed, so a mirrored legacy value still resolves but nothing new stores
  // it). The model rides the honored per-call param on NNA's notification route.
  const model = settings.smallModelUseDefault === false
    ? (settings as { smallModelOverride?: unknown }).smallModelOverride : undefined;
  if (settings.smallModelUseDefault === false && (typeof model !== 'string' || !model.trim())) {
    return Response.json({ error: { message: 'No notification model is configured' } }, { status: 404 });
  }
  signal?.throwIfAborted();
  return callHarness(harnessRequest(`/v1/nnd/sessions/${encodeURIComponent(String(raw.sessionID))}/notification-text`, String(raw.directory), {
    method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      kind: input.event, title: input.fallback.title, body: input.fallback.body, assistantText: input.assistantText,
      ...(model === undefined ? {} : { model }),
    }),
  }));
}
