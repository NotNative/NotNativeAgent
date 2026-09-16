// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt navigator rail (doc 05 §A.8, v1): a dot per user prompt, teleports
 * (instant) to the turn anchor; hidden until ≥2 prompts; windowing +
 * 'Load more prompts' ride the virtualization slice.
 */
import type { ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import { projectTurns, type PartLite } from './turns.ts';

const MIN_PROMPTS = 2;

export function PromptNavigatorRail({ store, sessionID }: { store: StoreApi<DirectoryStore>; sessionID: string | null }): ReactNode {
  const snapshot = store.getState();
  const messages = snapshot.message[sessionID ?? ''] ?? [];
  const turns = projectTurns(messages);
  const prompts = turns.map((turn) => ({
    id: turn.userMessage.id,
    text: ((snapshot.part[turn.userMessage.id] ?? []) as PartLite[]).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n').trim(),
  })).filter((prompt) => prompt.text.length > 0);
  if (prompts.length < MIN_PROMPTS) return null;

  return (
    <nav aria-label="Prompt navigation" className="absolute right-0 top-16 mr-1 flex flex-col items-center gap-2" data-testid="prompt-rail">
      {prompts.map((prompt) => (
        <button
          key={prompt.id}
          type="button"
          title={prompt.text.slice(0, 80)}
          aria-label={`Jump to prompt: ${prompt.text.slice(0, 40)}`}
          onClick={() => {
            window.location.hash = '';
            window.location.hash = `#message-${prompt.id}`;
            document.getElementById(`message-${prompt.id}`)?.scrollIntoView({ block: 'start' });
          }}
          className="h-2 w-2 rounded-full bg-neutral-600 hover:bg-amber-400"
        />
      ))}
    </nav>
  );
}
