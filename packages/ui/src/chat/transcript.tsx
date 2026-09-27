// SPDX-License-Identifier: Apache-2.0
/**
 * Transcript (doc 05 §C, v1): turn projection render, streaming tail, part
 * dispatch, tool cards (plain bodies; rich diff lands with P6), facts footer,
 * error callouts, status chip (§E.1), and §F blocking cards.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { AssistantMessage, PermissionRequest, QuestionRequest, SessionStatus } from '../lib/nnd/types.ts';
import type { DirectoryStore } from '../sync/types.ts';
import type { SessionMessageLoadState } from '../sync/session-message-loader.ts';
import { useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { projectTurns, streamingTail, turnSettled, assistantLiveStatus, toolPhrase, workingPhrase, type PartLite, type ChatTurn } from './turns.ts';
import { renderMarkdown } from './markdown-lite.tsx';
import { ToolCard } from './tool-cards.tsx';
import { BlockingCardsColumn } from './blocking-cards.tsx';
import { formatDuration, formatRelative, formatRetryCountdown } from './time-format.ts';

export interface TranscriptProps {
  store: StoreApi<DirectoryStore>;
  engine: SyncEngine;
  sessionID: string | null;
  directory: string;
}

export function Transcript(props: TranscriptProps): ReactNode {
  const { store, engine, sessionID, directory } = props;
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const [retry, setRetry] = useState<{ key: string; count: number }>({ key: '', count: 0 });
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<{ key: string; state: SessionMessageLoadState } | null>(null);
  const [olderBusyKey, setOlderBusyKey] = useState<string | null>(null);
  const [olderFailedKey, setOlderFailedKey] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const olderAnchor = useRef<{ key: string; store: StoreApi<DirectoryStore>; firstMessageID: string; id: string; top: number; viewport: HTMLElement } | null>(null);
  const loadKey = `${directory}\n${sessionID ?? ''}`;
  useLayoutEffect(() => {
    const anchor = olderAnchor.current;
    if (!anchor) return;
    if (anchor.key !== loadKey || anchor.store !== store) {
      olderAnchor.current = null;
      return;
    }
    if (snapshot.message[sessionID ?? '']?.[0]?.id === anchor.firstMessageID) return;
    const node = [...(transcriptRef.current?.querySelectorAll<HTMLElement>('[id^="message-"]') ?? [])]
      .find((candidate) => candidate.id === anchor.id);
    if (!node) return;
    anchor.viewport.scrollTop += node.getBoundingClientRect().top - anchor.top;
    olderAnchor.current = null;
  }, [loadKey, store, snapshot.message]);
  useEffect(() => {
    if (!sessionID) return;
    let active = true;
    const target = { directory, sessionID, store };
    const force = retry.key === loadKey && retry.count > 0;
    void engine.loader.ensure(target, { reason: 'navigation', force })
      .then(() => {
        if (active) {
          const next = engine.loader.getState(target);
          setLoadState({ key: loadKey, state: next });
          setFailedKey(next.status === 'error' ? loadKey : null);
        }
      })
      .catch(() => {
        if (active) setFailedKey(loadKey);
      });
    return () => { active = false; };
  }, [engine.loader, store, directory, sessionID, loadKey, retry]);
  if (!sessionID) {
    return <div className="mx-auto max-w-xl px-6 py-16 text-center text-sm text-neutral-600" data-testid="chat-empty">No session selected — open the sidebar to start.</div>;
  }
  if (snapshot.message[sessionID] === undefined || snapshot.message[sessionID]?.length === 0) {
    if (failedKey === loadKey) {
      return <div className="mx-auto max-w-xl px-6 py-16 text-center text-sm text-neutral-400" data-testid="chat-load-error">
        <p>Could not load this session’s messages.</p>
        <button type="button" className="mt-3 rounded border border-white/15 px-3 py-1.5 text-neutral-200 hover:bg-white/10"
          onClick={() => { setFailedKey(null); setRetry((value) => ({ key: loadKey, count: value.key === loadKey ? value.count + 1 : 1 })); }}>Retry</button>
      </div>;
    }
  }
  if (snapshot.message[sessionID] === undefined) {
    return <Skeleton />;
  }
  if ((snapshot.message[sessionID]?.length ?? 0) === 0) {
    return <div className="mx-auto max-w-xl px-6 py-16 text-center text-sm text-neutral-600" data-testid="chat-empty">Session is open, nothing has been sent yet.</div>;
  }
  const turns = projectTurns(snapshot.message[sessionID] ?? []);
  const tail = streamingTail(turns);
  const lastIndex = turns.length - 1;
  const currentLoad = loadState?.key === loadKey ? loadState.state : null;
  const canLoadOlder = !!currentLoad?.cursor && !currentLoad.complete;
  const loadOlder = async (): Promise<void> => {
    if (olderBusyKey === loadKey) return;
    const viewport = transcriptRef.current?.closest<HTMLElement>('[data-chat-column]');
    const anchor = transcriptRef.current?.querySelector<HTMLElement>('[id^="message-"]');
    const firstMessageID = snapshot.message[sessionID]?.[0]?.id;
    olderAnchor.current = viewport && anchor && firstMessageID
      ? { key: loadKey, store, firstMessageID, id: anchor.id, top: anchor.getBoundingClientRect().top, viewport }
      : null;
    setOlderBusyKey(loadKey);
    setOlderFailedKey(null);
    const target = { directory, sessionID, store };
    try {
      await engine.loader.loadOlder(target);
      const next = engine.loader.getState(target);
      setLoadState({ key: loadKey, state: next });
      if (next.status === 'error') setOlderFailedKey(loadKey);
    } catch {
      setOlderFailedKey(loadKey);
    } finally {
      // The store may publish before React commits the new rows. Keep the
      // anchor for useLayoutEffect when a page actually prepended; discard it
      // immediately only when no first-message change can consume it.
      if (olderAnchor.current?.key === loadKey && olderAnchor.current.store === store
        && store.getState().message[sessionID]?.[0]?.id === olderAnchor.current.firstMessageID) {
        olderAnchor.current = null;
      }
      setOlderBusyKey((current) => current === loadKey ? null : current);
    }
  };
  return (
    <div ref={transcriptRef} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6" data-testid="chat-transcript">
      {canLoadOlder ? <div className="flex flex-col items-center gap-1 text-xs">
        <button type="button" disabled={olderBusyKey === loadKey} onClick={() => { void loadOlder(); }}
          className="rounded border border-white/15 px-3 py-1.5 text-neutral-300 hover:bg-white/10 disabled:opacity-50"
          data-testid="load-older-messages">{olderBusyKey === loadKey ? 'Loading older messages…' : 'Load older messages'}</button>
        {olderFailedKey === loadKey ? <span role="alert" className="text-rose-400">Could not load older messages. Retry above.</span> : null}
      </div> : null}
      {turns.map((turn, index) => (
        <TurnRow key={turn.userMessage.id} turn={turn} store={store} engine={engine} tailID={index === lastIndex ? tail?.id : undefined} />
      ))}
      {tail ? <StreamingTailRow key={tail.id} parts={(snapshot.part[tail.id] ?? []) as PartLite[]} messageID={tail.id} /> : null}
      {permissionsOf(snapshot, sessionID).length > 0 || questionsOf(snapshot, sessionID).length > 0
        ? <BlockingCardsColumn store={store} engine={engine} sessionID={sessionID} />
        : null}
    </div>
  );
}

function permissionsOf(snapshot: import('../sync/types.ts').DirectoryStore, sessionID: string) {
  return snapshot.permission[sessionID] ?? [];
}
function questionsOf(snapshot: import('../sync/types.ts').DirectoryStore, sessionID: string) {
  return snapshot.question[sessionID] ?? [];
}

function Skeleton(): ReactNode {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 pt-6" data-chat-hydration-skeleton>
      {[0, 1, 2].map((row) => (
        <div key={row} className="animate-pulse rounded-lg bg-white/5 p-3">
          <div className="mb-2 h-2 w-24 rounded bg-white/10" />
          <div className="h-2 w-3/4 rounded bg-white/10" />
        </div>
      ))}
    </div>
  );
}

function TurnRow({ turn, store, engine, tailID }: { turn: ChatTurn; store: StoreApi<DirectoryStore>; engine: SyncEngine; tailID: string | undefined }): ReactNode {
  const [open, setOpen] = useState(true);
  const partsOf = (id: string): PartLite[] => (store.getState().part[id] ?? []) as PartLite[];
  const settled = turnSettled(turn);
  const inline = tailID ? turn.assistant.filter((message) => message.id !== tailID) : turn.assistant;
  return (
    <section className="flex flex-col gap-3" data-testid="chat-turn">
      <UserBubble parts={partsOf(turn.userMessage.id)} anchorID={turn.userMessage.id} />
      {settled && inline.length > 1 ? (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="self-start rounded-full bg-white/5 px-3 py-1 text-[11px] text-neutral-400 hover:text-neutral-200">
          Activity ({inline.length}) {open ? 'âˆ’' : '+'}
        </button>
      ) : null}
      {open ? inline.map((message) => (
        <AssistantRow key={message.id} message={message} parts={partsOf(message.id)} anchorID={message.id} live={tailID === message.id ? false : message.time.completed === undefined} />
      )) : null}
    </section>
  );
}

function presentationOf(message: import('../lib/nnd/types.ts').Message): import('../lib/nnd/types.ts').PresentationMessage {
  return message as unknown as import('../lib/nnd/types.ts').PresentationMessage;
}

function UserBubble({ parts, anchorID }: { parts: PartLite[]; anchorID: string }): ReactNode {
  const text = parts.filter((part) => part.type === 'text' && !part.synthetic && !part.ignored).map((part) => part.text ?? '').join('');
  return (
    <div id={`message-${anchorID}`} className="flex scroll-mt-16 justify-end">
      <div className={`max-w-[85%] rounded-xl p-3 text-sm text-neutral-100 ${text.startsWith('!') || text.startsWith('/') ? 'bg-neutral-800/80 font-mono text-[13px]' : 'bg-indigo-950/60'}`}>
        {text.startsWith('!') ? <span aria-hidden className="mr-1 text-amber-300">$</span> : null}
        {text || '[No text content]'}
      </div>
    </div>
  );
}

function AssistantRow({ message, parts, live, anchorID }: { message: import('../lib/nnd/types.ts').PresentationMessage; parts: PartLite[]; live: boolean; anchorID?: string }): ReactNode {
  const visible = parts.filter((part) => !SKIP_KIND.has(part.type) && !part.synthetic && !part.ignored);
  return (
    <article id={anchorID ? `message-${anchorID}` : undefined} className="flex flex-col gap-1 scroll-mt-16" data-testid="chat-assistant-row">
      {visible.map((part, index) => <PartView key={index} part={part} />)}
      {message.error ? <ErrorCallout message={message.error} /> : null}
      <footer className="flex items-center gap-2 px-1 text-[10px] text-neutral-600">
        <span>{[message.modelID, message.providerID].filter(Boolean).join(' · ')}</span>
        <span>{formatDuration(message.time.created, message.time.completed)}</span>
        <span>{formatRelative(message.time.completed ?? message.time.created)}</span>
        {live ? <span className="text-amber-500/70">{workingPhrase(message.id)}…</span> : null}
      </footer>
    </article>
  );
}

const SKIP_KIND = new Set(['step-start', 'step-finish', 'patch']);

function PartView({ part }: { part: PartLite }): ReactNode {
  switch (part.type) {
    case 'text':
      return <div className="flex flex-col gap-1.5">{renderMarkdown(typeof part.text === 'string' ? part.text : '')}</div>;
    case 'reasoning':
      return <ReasoningBlock body={typeof part.text === 'string' ? part.text : ''} />;
    case 'tool':
      return <ToolCard part={part} />;
    case 'subtask':
      return <SubtaskCard description={typeof part.description === 'string' ? part.description : ''} />;
    case 'file':
      return <span className="text-[11px] text-neutral-500">[attachment {String((part as { filename?: string }).filename ?? 'file')}]</span>;
    default:
      return null; // unknown part types never throw and never render (doc 05 §0.3)
  }
}

function ReasoningBlock({ body }: { body: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l-2 border-indigo-800/60 pl-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-[11px] uppercase tracking-wide text-indigo-300/80">
        Reasoning {open ? 'âˆ’' : '+'}
      </button>
      {open ? <p className="whitespace-pre-wrap text-[13px] leading-6 text-neutral-400">{body}</p> : null}
    </div>
  );
}

function SubtaskCard({ description }: { description: string }): ReactNode {
  return <div className="rounded-lg border border-white/10 bg-neutral-900/70 p-3 text-[12px] text-neutral-300">Delegated task{description ? ` — ${description}` : ''}</div>;
}

function ErrorCallout({ message }: { message: { name?: string; message?: string; data?: { message?: string } } | undefined }): ReactNode {
  const bag = (message ?? {}) as { name?: string; message?: string; data?: { message?: string } };
  const detail = bag.data?.message ?? bag.message ?? bag.name ?? 'unknown';
  return (
    <div className="rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-[12px] text-red-300" data-testid="chat-error-callout">
      <strong className="font-medium">Unable to respond.</strong> The harness reported: {detail}. Nothing is lost — retry when it is back.
    </div>
  );
}

function StreamingTailRow({ parts, messageID }: { parts: PartLite[]; messageID: string }): ReactNode {
  const live = assistantLiveStatus(() => parts, messageID);
  const phrase = live ? (live.kind === 'thinking' ? 'thinking' : live.kind === 'tool' ? toolPhrase(live.tool) : 'composing') : workingPhrase(messageID);
  const visible = parts.filter((part) => !SKIP_KIND.has(part.type) && !part.synthetic && !part.ignored);
  return (
    <article className="rounded-lg bg-neutral-900/60 p-3" data-testid="chat-streaming-tail" data-streaming="true">
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-amber-400/80">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        {phrase}
      </div>
      <div className="flex flex-col gap-2">
        {visible.map((part, index) => <PartView key={index} part={part} />)}
        {visible.every((part) => part.type !== 'text') ? <StreamPlaceholder /> : null}
      </div>
    </article>
  );
}

function StreamPlaceholder(): ReactNode {
  return <div className="flex items-center gap-1.5" aria-hidden><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:120ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:240ms]" /></div>;
}

/** Working / waiting / retry chip above the composer (§E.1 derivation). */
export function StatusChip({ store, sessionID }: { store: StoreApi<DirectoryStore>; sessionID: string | null }): ReactNode {
  const statusById = useSyncExternalStore(useGlobalSessionStatusStore.subscribe, pickStatusById);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const messageID = lastAssistantId(store, sessionID);
  const live = assistantLiveStatus((id) => (snapshot.part[id] ?? []) as PartLite[], messageID);
  const permissionPending = sessionID ? (snapshot.permission[sessionID]?.length ?? 0) > 0 : false;
  const questionPending = sessionID ? (snapshot.question[sessionID]?.length ?? 0) > 0 : false;
  const status: SessionStatus | undefined = sessionID ? statusById[sessionID] : undefined;
  if (permissionPending || questionPending) {
    return <aside data-testid="status-chip" data-waiting="true" aria-live="assertive" className="absolute bottom-full left-4 mb-2 rounded-full bg-amber-500/15 px-3 py-1 text-[11px] text-amber-300">Waiting for you — respond to the request above</aside>;
  }
  if (status?.type === 'retry') {
    return <aside data-testid="status-chip" className="absolute bottom-full left-4 mb-2 rounded-full bg-amber-600/20 px-3 py-1 text-[11px] text-amber-200">{formatRetryCountdown(status.next ?? 0)} (attempt {status.attempt}): {status.message}</aside>;
  }
  if (status?.type === 'busy') {
    const working = live?.kind === 'thinking' ? 'thinking' : live?.kind === 'tool' ? toolPhrase(live.tool) : live?.kind === 'composing' ? 'composing' : workingPhrase(messageID ?? 'idle');
    return <aside data-testid="status-chip" className="absolute bottom-full left-4 mb-2 rounded-full bg-neutral-800/90 px-3 py-1 text-[11px] text-neutral-300">mock-smart is {working}<BusyDots /></aside>;
  }
  return null;
}

function pickStatusById(): Record<string, SessionStatus> {
  return useGlobalSessionStatusStore.getState().statusById;
}

function BusyDots(): ReactNode {
  return (
    <span className="ml-1 inline-flex gap-0.5" aria-hidden>
      <span className="h-1 w-1 animate-bounce rounded-full bg-neutral-400" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-neutral-400 [animation-delay:120ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-neutral-400 [animation-delay:240ms]" />
    </span>
  );
}

function lastAssistantId(store: StoreApi<DirectoryStore>, sessionID: string | null): string | undefined {
  if (!sessionID) return undefined;
  const messages = store.getState().message[sessionID] ?? [];
  const trailing = messages.at(-1);
  return trailing && trailing.role === 'assistant' && trailing.time.completed === undefined ? trailing.id : undefined;
}

