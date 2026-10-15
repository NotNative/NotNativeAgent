// SPDX-License-Identifier: Apache-2.0
/**
 * Composer presentational pieces (P3a v1) — footer controls, attachment
 * citation chips, and the autocomplete popup. Kept separate so the composer
 * orchestrator stays under the GUI matrix caps (ADR 0017). The server queue
 * chips row (doc 12 §D.6/§D.7) reads the messageQueueStore projection.
 */
import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { AutocompleteTrigger } from './prompt-language.ts';
import type { DraftAttachment } from './drafts.ts';
import { useMessageQueueStore, queueKey, normalizeFollowUpBehavior } from '../stores/useMessageQueueStore.ts';
import { setSettingsField, useSettingsStore } from '../lib/settings/store.ts';
import { toast } from 'sonner';
import { starterInsertText, removeStarter, type Starter } from './starters.ts';

export function AttachmentChips({ attachments, onRemove }: { attachments: DraftAttachment[]; onRemove: (next: DraftAttachment[]) => void }): ReactNode {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-1 pt-1" data-testid="composer-attachments">
      {attachments.map((a) => (
        <span key={a.name} className="rounded bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">[{a.name}]
          <button type="button" aria-label={`Remove ${a.name}`} className="ml-1 text-neutral-500 hover:text-white" onClick={() => onRemove(attachments.filter((x) => x.name !== a.name))}>×</button>
        </span>
      ))}
    </div>
  );
}

export function PickerPopup({ picker }: { picker: { trigger: AutocompleteTrigger; items: string[]; insert: (item: string) => void } | null }): ReactNode {
  if (!picker) return null;
  return (
    <div className="absolute bottom-full left-2 z-10 max-h-64 w-72 overflow-auto rounded-lg border border-white/10 bg-neutral-950 shadow-xl" data-testid="composer-picker">
      {picker.items.length === 0
        ? <div className="px-3 py-2 text-[11px] text-neutral-600">No matches</div>
        : picker.items.map((item) => (
            <button key={item} type="button" onClick={() => picker.insert(item)} className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/5">
              {item}
            </button>
          ))}
    </div>
  );
}

export function DraftStarterChips({ directory, currentText, starters, onApply }: {
  directory: string;
  currentText: string;
  starters: Starter[];
  onApply: (nextText: string) => void;
}): ReactNode {
  if (starters.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2" data-testid="starter-chips">
      {starters.map((starter) => (
        <span key={starter.id} className="group inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-neutral-400 hover:border-white/20 hover:text-neutral-200">
          <button type="button" onClick={() => onApply(starterInsertText(starter, currentText))}>{starter.label}</button>
          <button type="button" aria-label={`Remove ${starter.label}`} className="ml-2 hidden text-neutral-600 group-hover:inline" onClick={() => {
            removeStarter(starter.id, directory);
          }}>×</button>
        </span>
      ))}
    </div>
  );
}

export interface ComposerFooterProps {
  busy: boolean;
  canSend: boolean;
  onStop: () => void;
  agent: string;
  agents: string[];
  onAgent: (agent: string) => void;
  configuredByNna: boolean;
  onFiles: (files: FileList) => void;
  locked?: boolean;
}

export function ComposerFooter(props: ComposerFooterProps): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
      <div className="flex items-center gap-2 text-[12px] text-neutral-400">
        {props.configuredByNna ? <span title="Agent routing is governed by NNA">NNA governed</span> : (
          <select aria-label="Agent persona" value={props.agent} onChange={(event) => props.onAgent(event.target.value)} className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-indigo-300">
            {props.agents.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-neutral-300 hover:border-white/25 hover:bg-white/5" title="Attach files">
          <span aria-hidden className="text-base leading-none">+</span> Attach files
          <input type="file" disabled={props.locked} multiple className="hidden" onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) props.onFiles(event.target.files);
            event.target.value = '';
          }} />
        </label>
        {props.busy ? (
          <button type="button" aria-label="Stop generating" className="rounded px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10" onClick={props.onStop}>
            stop
          </button>
        ) : null}
        <button type="submit" disabled={!props.canSend} aria-label="Send message" className="rounded bg-white/90 px-3 py-1.5 text-[11px] font-medium text-black disabled:opacity-40">
          send
        </button>
      </div>
    </div>
  );
}

// ── server-queue chips (doc 12 §D.6/§D.7) ───────────────────────────────────

const EMPTY_ITEMS: import('../stores/useMessageQueueStore.ts').QueuedItemPublic[] = [];
const EMPTY_SENDING: string[] = [];

/** The server-owned queue projection for an OPEN session: FIFO chips with
 *  reorder (▲▼), remove (×), pop-to-input, and clear; the follow-up toggle
 *  mirrors the §D.7 settings field. Draft columns render the local queue via
 *  their own chips row. */
export function QueueChipsRow({ directory, sessionID, onPop }: { directory: string; sessionID: string | null; onPop: (text: string) => void }): ReactNode {
  const target = sessionID ?? '';
  // Zero-arg snapshot reads (useSyncExternalStore contract) with STABLE
  // fallbacks; a fresh `[]` per call would trip React's bailout detection.
  const readItems = useMemo(() => {
    const key = queueKey(directory, target);
    return (): import('../stores/useMessageQueueStore.ts').QueuedItemPublic[] => useMessageQueueStore.getState().queuedMessages[key] ?? EMPTY_ITEMS;
  }, [directory, target]);
  const readSending = useMemo(() => {
    const key = queueKey(directory, target);
    return (): string[] => useMessageQueueStore.getState().sendingIds[key] ?? EMPTY_SENDING;
  }, [directory, target]);
  const subscribe = useMessageQueueStore.subscribe;
  const items = useSyncExternalStore(subscribe, readItems);
  const sending = useSyncExternalStore(subscribe, readSending);
  const followUpRaw = useSettingsStore((state) => state.doc['followUpBehavior']);
  const followUp = normalizeFollowUpBehavior(followUpRaw);
  if (sessionID === null || items.length === 0) return null;
  return (
    <div className="px-1 pt-1" data-testid="queue-chips-row" data-follow-up={followUp}>
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-amber-300/90">
        <span>queued on server ({items.length})</span>
        <button
          type="button"
          data-testid="queue-followup-toggle"
          aria-label={`Follow-up behavior: ${followUp} — toggle to ${followUp === 'queue' ? 'steer' : 'queue'}`}
          className="rounded bg-white/5 px-1.5 py-0.5 normal-case text-amber-200 hover:bg-white/10"
          onClick={() => setSettingsField('followUpBehavior', followUp === 'queue' ? 'steer' : 'queue')}
        >
          {followUp}
        </button>
        <button
          type="button"
          data-testid="queue-clear"
          className="rounded px-1.5 py-0.5 normal-case text-neutral-400 hover:text-red-300"
          onClick={() => {
            void useMessageQueueStore.getState().clearQueue(directory, sessionID).then((result) => {
              if (!result.ok) toast.error(result.error ?? 'Failed to clear the queue');
            });
          }}
        >
          clear
        </button>
      </div>
      <ol className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li key={item.id} className="flex items-center gap-1 rounded bg-white/5 px-2 py-1" data-testid="queue-chip">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sending.includes(item.id) ? 'bg-sky-400' : 'bg-amber-400'}`} />
            <button
              type="button"
              title={item.content.length > 120 ? item.content.slice(0, 120) : undefined}
              className="min-w-0 flex-1 truncate text-left text-[11px] text-neutral-300"
              onClick={() => {
                void useMessageQueueStore.getState().takeForInput(directory, sessionID, item.id).then((result) => {
                  if (!result.ok || !result.text) { toast.error(result.error ?? 'Failed to take the queued item'); return; }
                  onPop(result.text);
                  toast.message('Queued message moved back into the composer');
                });
              }}
            >
              {item.preview}
            </button>
            <span className="text-[10px] text-neutral-600">{index + 1}</span>
            <button type="button" aria-label="Move up" disabled={index === 0} data-testid={`queue-up-${item.id}`} onClick={() => void reorder(directory, sessionID, items, index, -1)}>▲</button>
            <button type="button" aria-label="Move down" disabled={index === items.length - 1} data-testid={`queue-down-${item.id}`} onClick={() => void reorder(directory, sessionID, items, index, 1)}>▼</button>
            <button type="button" aria-label="Remove from queue" data-testid={`queue-remove-${item.id}`} onClick={() => {
              void useMessageQueueStore.getState().removeFromQueue(directory, sessionID, item.id).then((result) => {
                if (!result.ok) toast.error(result.error ?? 'Failed to remove the queued item');
              });
            }}>×</button>
          </li>
        ))}
      </ol>
    </div>
  );
}

async function reorder(directory: string, sessionID: string, items: import('../stores/useMessageQueueStore.ts').QueuedItemPublic[], index: number, delta: -1 | 1): Promise<void> {
  const target = index + delta;
  if (target < 0 || target >= items.length) return;
  const ids = items.map((item) => item.id);
  const moved = [...ids];
  moved.splice(index, 1);
  moved.splice(target, 0, ids[index]!);
  const result = await useMessageQueueStore.getState().reorderQueue(directory, sessionID, moved);
  if (!result.ok) toast.error(result.error ?? 'Failed to reorder the queue');
}
