// SPDX-License-Identifier: Apache-2.0
/** NNA adapter ports for the mandatory-context restoration runtime. */
import { callHarness, callHarnessJson, harnessRequest } from '../queue/queue-adapter-calls.ts';
import type { KnowledgePreparation, ContextRestorationPorts } from './context-obligatory-runtime.ts';
import { createAgentMemoryKnowledgeProvider } from '../agent-tool/memory-delivery.ts';
import { OBLIGATORY_CURSOR_KEY, OBLIGATORY_KNOWLEDGE_KEY, OBLIGATORY_NAMESPACE } from './obligatory-messages.ts';

const PORT_TIMEOUT_MS = 20_000;

function path(id: string): string { return encodeURIComponent(id); }

function get(route: string, directory: string): Promise<unknown> {
  return callHarnessJson(harnessRequest(route, directory, {
    method: 'GET', signal: AbortSignal.timeout(PORT_TIMEOUT_MS),
  }));
}

export type ContextRestorationProvider = ContextRestorationPorts & {
  dispose: () => void;
  recordKnowledgeDelivered: (sessionId: string, directory: string) => void;
};

export function createNnaContextRestorationPorts(): ContextRestorationProvider {
  const knowledge = createAgentMemoryKnowledgeProvider();
  return {
    readSession: (id, directory) => get(`/session/${path(id)}`, directory),
    readMessages: (id, directory, limit) =>
      get(`/session/${path(id)}/message?limit=${Math.min(limit, 20)}`, directory),
    readMessage: (id, directory, messageId) =>
      get(`/session/${path(id)}/message/${path(messageId)}`, directory),
    resetKnowledgeDelivery: (id, directory) => {
      knowledge.resetSession(id, directory);
    },
    prepareKnowledge: async (id, directory): Promise<KnowledgePreparation | null> => {
      try {
        const text = await knowledge.resolve(id, directory);
        if (typeof text !== 'string' || text.trim() === '') return null;
        const signature = await createSignature(text);
        return { text, signature };
      } catch { return null; }
    },
    sendPrompt: async (id, directory, body) => {
      try {
        const response = await callHarness(harnessRequest(
          `/session/${path(id)}/prompt_async`, directory, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(PORT_TIMEOUT_MS),
          }));
        return { ok: response.ok };
      } catch { return { ok: false }; }
    },
    writeCursor: async (id, directory, cursorPatch) => {
      try {
        const session = await get(`/session/${path(id)}`, directory);
        if (!isRecord(session)) return false;
        const freshMetadata = (session as { metadata?: unknown }).metadata;
        const metadata = isRecord(freshMetadata) ? { ...freshMetadata } : {};
        const namespace = isRecord(metadata[OBLIGATORY_NAMESPACE])
          ? { ...metadata[OBLIGATORY_NAMESPACE] as Record<string, unknown> } : {};
        if (typeof cursorPatch[OBLIGATORY_CURSOR_KEY] === 'string') namespace[OBLIGATORY_CURSOR_KEY] = cursorPatch[OBLIGATORY_CURSOR_KEY];
        if (typeof cursorPatch[OBLIGATORY_KNOWLEDGE_KEY] === 'string') namespace[OBLIGATORY_KNOWLEDGE_KEY] = cursorPatch[OBLIGATORY_KNOWLEDGE_KEY];
        else delete namespace[OBLIGATORY_KNOWLEDGE_KEY];
        metadata[OBLIGATORY_NAMESPACE] = namespace;
        const response = await callHarness(harnessRequest(`/session/${path(id)}`, directory, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ metadata }), signal: AbortSignal.timeout(PORT_TIMEOUT_MS),
        }));
        return response.ok;
      } catch { return false; }
    },
    recordKnowledgeDelivered: (sessionId, directory) => knowledge.recordDelivered(sessionId, directory),
    dispose: () => knowledge.dispose(),
  };
}

async function createSignature(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
