// SPDX-License-Identifier: Apache-2.0
/**
 * Delivery hook seams (doc 12 §D.3.7): notification wiring joins via
 * `onPromptSent` — a delivered queued message marks the user message sent.
 * Today the registry ships empty (a no-op plugin list); the queue runtime
 * is the only authority that knows a queued prompt was accepted.
 */
export type PromptSentHook = (sessionId: string, directory: string, itemId: string) => void;

const promptSentHooks = new Set<PromptSentHook>();

export function onPromptSent(hook: PromptSentHook): () => void {
  promptSentHooks.add(hook);
  return () => promptSentHooks.delete(hook);
}

export function notifyPromptSent(sessionId: string, directory: string, itemId: string): void {
  for (const hook of [...promptSentHooks]) {
    try {
      hook(sessionId, directory, itemId);
    } catch {
      /* a failing hook must never break the delivery loop */
    }
  }
}

/** Seam (§D.3.6 step 5): the project-knowledge module does not exist yet —
 *  `resolve` returns null today, `recordDelivered` stays a no-op. */
export interface ProjectKnowledgeProvider {
  resolve(sessionId: string, directory: string): string | null | Promise<string | null>;
  recordDelivered(sessionId: string, directory: string): void;
}

export const NULL_KNOWLEDGE_PROVIDER: ProjectKnowledgeProvider = {
  resolve: () => null,
  recordDelivered: (_sessionId: string, _directory: string) => {
    void _sessionId;
    void _directory;
  },
};
