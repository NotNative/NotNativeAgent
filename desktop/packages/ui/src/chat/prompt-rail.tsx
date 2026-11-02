// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt navigator rail (doc 05 §A.8, v2): a dot per user prompt, teleports
 * (instant) to the turn anchor; hidden until ≥2 prompts; hovers open a
 * preview card with the prompt text and the newest prompt reads "current".
 * Subscribes reactively (§A.8 v2 fix: getState() once never re-rendered).
 */
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { PartLite } from './turns.ts';
import { projectTurns } from './turns.ts';

const MIN_PROMPTS = 2;
const PREVIEW_MAX = 240;
type RailMessage = Parameters<typeof projectTurns>[0][number];
const EMPTY_MESSAGES: RailMessage[] = [];

function newestFirst(a: number, b: number): number {
  return b - a;
}

export function PromptNavigatorRail({ store, sessionID }: { store: StoreApi<DirectoryStore>; sessionID: string | null }): ReactNode {
  const messages = useSyncExternalStore(store.subscribe, () => store.getState().message[sessionID ?? ''] ?? EMPTY_MESSAGES);
  const partIndex = useSyncExternalStore(store.subscribe, () => store.getState().part);
  const [hovered, setHovered] = useState<string | null>(null);

  const prompts = useMemo(() => {
    const turns = projectTurns(messages);
    return turns.map((turn) => ({
      id: turn.userMessage.id,
      at: turn.userMessage.time.created,
      text: ((partIndex[turn.userMessage.id] ?? []) as PartLite[]).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n').trim(),
    })).filter((prompt) => prompt.text.length > 0).sort((a, b) => newestFirst(a.at, b.at));
  }, [messages, partIndex]);

  if (prompts.length < MIN_PROMPTS) return null;
  const hoveredPrompt = prompts.find((prompt) => prompt.id === hovered) ?? null;

  return (
    <nav aria-label="Prompt navigation" className="absolute right-0 top-16 mr-1 flex flex-col items-center gap-2" data-testid="prompt-rail">
      {prompts.map((prompt, index) => (
        <button
          key={prompt.id}
          type="button"
          data-testid={`prompt-dot-${index}`}
          aria-label={`Jump to prompt ${prompts.length - index} of ${prompts.length}: ${prompt.text.slice(0, 40)}`}
          onClick={() => {
            window.location.hash = '';
            window.location.hash = `#message-${prompt.id}`;
            document.getElementById(`message-${prompt.id}`)?.scrollIntoView({ block: 'start' });
          }}
          onMouseEnter={() => setHovered(prompt.id)}
          onMouseLeave={() => setHovered((current) => (current === prompt.id ? null : current))}
          className={`h-2 w-2 rounded-full ${prompt.id === prompts[0]?.id ? 'bg-tone-warning/18' : 'bg-card'} hover:bg-primary`}
        />
      ))}
      {hoveredPrompt ? (
        <div
          data-testid="prompt-rail-preview"
          className="absolute right-4 top-0 w-64 rounded-lg border border-border/10 bg-popover/95 p-2 text-[length:var(--type-meta)] text-muted-foreground shadow-xl"
        >
          <div className="mb-1 flex items-baseline justify-between gap-2 uppercase tracking-wide text-[length:var(--type-micro)] text-muted-foreground">
            <span>Prompt {prompts.indexOf(hoveredPrompt) + 1} of {prompts.length}</span>
            {hoveredPrompt.id === prompts[0]?.id ? <span className="text-tone-warning" data-testid="prompt-rail-current-label">Current prompt</span> : null}
          </div>
          <p className="whitespace-pre-wrap break-words">{hoveredPrompt.text.length > PREVIEW_MAX ? `${hoveredPrompt.text.slice(0, PREVIEW_MAX)}…` : hoveredPrompt.text}</p>
        </div>
      ) : null}
    </nav>
  );
}
