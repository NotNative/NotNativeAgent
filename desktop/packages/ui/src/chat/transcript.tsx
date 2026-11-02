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
import { isNnaActivitySource } from '../sync/activity-snapshot.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { toast } from 'sonner';
import { projectTurns, streamingTail, turnSettled, assistantLiveStatus, toolPhrase, workingPhrase, type PartLite, type ChatTurn } from './turns.ts';
import { renderMarkdown } from './markdown-lite.tsx';
import { prepareLocalMarkdownImages, type PreparedMarkdownImage } from './markdown-image-assets.ts';
import { ToolCard } from './tool-cards.tsx';
import { BlockingCardsColumn } from './blocking-cards.tsx';
import { formatDuration, formatRelative, formatRetryCountdown } from './time-format.ts';
import { filterBtwTailMessages } from './btw-context.ts';
import { TURN_WINDOW, hiddenTurnCount, turnHoldsMessage, windowStartIndex } from './turn-window.ts';
import {
  messagePinnedState, setSessionMessagePinned,
} from './context-message-pins.ts';
import { useSessionOrgStore } from '../stores/useSessionOrgStore.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { btwRiderFor } from './btw-context.ts';
import { btwStateMerged } from './btw-org.ts';
import { useSettingsStore } from '../lib/settings/store.ts';
import { Box, Button, Callout, Disclosure, Dot, Floating, Row } from '../components/ui/primitives.tsx';

export interface TranscriptProps {
  store: StoreApi<DirectoryStore>;
  engine: SyncEngine;
  sessionID: string | null;
  directory: string;
}

export function Transcript(props: TranscriptProps): ReactNode {
  const wide = useSettingsStore(state => state.doc.wideChatLayoutEnabled === true);
  const { store, engine, sessionID, directory } = props;
  const orgRecord = useSessionOrgStore((state) =>
    state.recordsByDirectory[normalizeDirectory(directory)]?.[sessionID ?? '']);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const [retry, setRetry] = useState<{ key: string; count: number }>({ key: '', count: 0 });
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<{ key: string; state: SessionMessageLoadState } | null>(null);
  const [olderBusyKey, setOlderBusyKey] = useState<string | null>(null);
  const [olderFailedKey, setOlderFailedKey] = useState<string | null>(null);
  const [hashTick, setHashTick] = useState(0);
  // W-27 virtualization expansion lives with the other hooks (rules of hooks).
  const [expandedTurns, setExpandedTurns] = useState(0);
  useEffect(() => { setExpandedTurns(0); }, [sessionID]); // fresh window per session
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // Deep links: `#message-<id>` scrolls to and briefly highlights a stable
  // per-message anchor; the hash survives paging because the id is projected
  // from session identity, not list position.
  useEffect(() => {
    const onHashChange = (): void => setHashTick((tick) => tick + 1);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => {
    const match = /^#message-(.+)$/u.exec(window.location.hash);
    const raw = match?.[1];
    if (!raw || !sessionID) return;
    const targetID = decodeURIComponent(raw);
    const node = transcriptRef.current?.querySelector<HTMLElement>(`[id="message-${targetID.replace(/[\\"]/gu, '\\$&')}"]`);
    if (!node) {
      // W-27: the anchor may be hidden by the turn window — expand the
      // window when the target message exists in the loaded transcript, then
      // this effect re-runs (same hashTick after the state update) and finds it.
      if ((snapshot.message[sessionID] ?? []).some((message) => message.id === targetID)) {
        setExpandedTurns(Number.MAX_SAFE_INTEGER);
      }
      return;
    }
    node.scrollIntoView({ block: 'center' });
    node.classList.add('outline', 'outline-2', 'outline-tone-warning-border/60', 'rounded-lg');
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      node.classList.remove('outline', 'outline-2', 'outline-tone-warning-border/60', 'rounded-lg');
    }, 1600);
    return () => { if (highlightTimer.current) { clearTimeout(highlightTimer.current); highlightTimer.current = null; } };
  }, [loadKey, sessionID, hashTick, snapshot.message, expandedTurns]);
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
    return <div className="mx-auto max-w-xl p-[var(--space-6)] py-[var(--space-8)] text-center text-[length:var(--type-meta)] text-muted-foreground" data-testid="chat-empty">No session selected — open the sidebar to start.</div>;
  }
  if (snapshot.message[sessionID] === undefined || snapshot.message[sessionID]?.length === 0) {
    if (failedKey === loadKey) {
      return <div className="mx-auto max-w-xl p-[var(--space-6)] py-[var(--space-8)] text-center text-[length:var(--type-meta)] text-muted-foreground" data-testid="chat-load-error">
        <p>Could not load this session’s messages.</p>
        <Button variant="secondary" className="mt-[var(--space-3)]" onClick={() => { setFailedKey(null); setRetry((value) => ({ key: loadKey, count: value.key === loadKey ? value.count + 1 : 1 })); }}>Retry</Button>
      </div>;
    }
  }
  if (snapshot.message[sessionID] === undefined) {
    return <Skeleton />;
  }
  if ((snapshot.message[sessionID]?.length ?? 0) === 0) {
    return <div className="mx-auto max-w-xl p-[var(--space-6)] py-[var(--space-8)] text-center text-[length:var(--type-meta)] text-muted-foreground" data-testid="chat-empty">Session is open, nothing has been sent yet.</div>;
  }
  const sessionRow = snapshot.session.find((session) => session.id === sessionID);
  const btwState = btwStateMerged(sessionRow?.metadata, orgRecord);
  const sourceMessages: Parameters<typeof projectTurns>[0] = filterBtwTailMessages(
    snapshot.message[sessionID] ?? [],
    btwState.active || btwState.promoted ? btwState.boundaryMessageID : null,
  ) as Parameters<typeof projectTurns>[0];
  const turns = projectTurns(sourceMessages);
  // W-27 virtualization: render a newest-first window; older loaded turns
  // stay one click away and a deep link into a hidden turn expands fully.
  const hiddenCount = hiddenTurnCount(turns.length, expandedTurns);
  const fromIndex = windowStartIndex(turns.length, expandedTurns);
  const visibleTurns = hiddenCount > 0 ? turns.slice(fromIndex) : turns;
  const tail = streamingTail(turns);
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
    <div ref={transcriptRef} className={`mx-auto flex w-full ${wide ? 'max-w-none' : 'max-w-3xl'} flex-col gap-3 px-4 pt-4`} data-testid="chat-transcript">
      {canLoadOlder ? <div className="flex flex-col items-center gap-1 text-xs">
        <button type="button" disabled={olderBusyKey === loadKey} onClick={() => { void loadOlder(); }}
          className="rounded border border-border/60 px-3 py-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
          data-testid="load-older-messages">{olderBusyKey === loadKey ? 'Loading older messages…' : 'Load older messages'}</button>
        {olderFailedKey === loadKey ? <span role="alert" className="text-tone-error">Could not load older messages. Retry above.</span> : null}
      </div> : null}
      {hiddenCount > 0 ? (
        <button type="button" onClick={() => setExpandedTurns(Number.MAX_SAFE_INTEGER)}
          className="mx-auto rounded border border-border/60 px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
          data-testid="show-older-turns">Show {hiddenCount} older turns</button>
      ) : null}
      {visibleTurns.map((turn, index) => {
        const pin = { store, sessionID, directory };
        return <TurnRow key={turn.userMessage.id} turn={turn} engine={engine} tailID={index === visibleTurns.length - 1 ? tail?.id : undefined} pin={pin} />;
      })}
      {tail ? <StreamingTailRow key={tail.id} parts={(snapshot.part[tail.id] ?? []) as PartLite[]} messageID={tail.id} sessionID={sessionID} directory={directory} /> : null}
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

function ContextPinButton({ pin, message, variant }: {  pin: ContextPinTarget;
  message: ContextPinMessage;
  variant: 'user' | 'assistant';
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const snapshot = useSyncExternalStore(pin.store.subscribe, pin.store.getState);
  const orgRecord = useSessionOrgStore((state) =>
    state.recordsByDirectory[normalizeDirectory(pin.directory)]?.[pin.sessionID]);
  const session = snapshot.session.find((entry) => entry.id === pin.sessionID);
  const pinned = messagePinnedState(session, orgRecord).has(message.id);
  const toggle = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await setSessionMessagePinned({
        sessionID: pin.sessionID, directory: pin.directory, message, pinned: !pinned,
        ...(session?.metadata ? { metadata: session.metadata } : {}),
      });
    } catch {
      if (active.current) toast.error('Could not update the context pin');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[length:var(--type-micro)] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-border disabled:opacity-50"
      aria-pressed={pinned} disabled={busy} data-testid={`chat-context-pin-${message.id}`}
      onClick={() => void toggle()}>
      {pinned ? `${variant === 'user' ? 'Unpin message' : 'Unpin'}` : `${variant === 'user' ? 'Pin message' : 'Pin'}`}
    </button>
  );
}

type ContextPinMessage = {
  id: string;
  role: 'user' | 'assistant';
  time: { created: number; completed?: number };
};

function Skeleton(): ReactNode {
  // A skeleton is made of the same tiles as the rows it stands in for, so the
  // shape of the chat is recognisable before the first message lands.
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-[var(--space-3)] px-[var(--space-4)] pt-[var(--space-6)]" data-chat-hydration-skeleton>
      {[0, 1, 2].map((row) => (
        <div key={row} className="ui-tile animate-pulse rounded-[var(--radius-card)] p-[var(--space-3)]">
          <div className="mb-[var(--space-2)] h-2 w-24 rounded bg-card" />
          <div className="h-2 w-3/4 rounded bg-card" />
        </div>
      ))}
    </div>
  );
}

type ContextPinTarget = {  store: StoreApi<DirectoryStore>;
  sessionID: string;
  directory: string;
};

function TurnRow({ turn, engine, tailID, pin }: { turn: ChatTurn; engine: SyncEngine; tailID: string | undefined; pin: ContextPinTarget }): ReactNode {
  const [open, setOpen] = useState(true);
  const store = pin.store;
  const partsOf = (id: string): PartLite[] => (store.getState().part[id] ?? []) as PartLite[];
  const settled = turnSettled(turn);
  const inline = tailID ? turn.assistant.filter((message) => message.id !== tailID) : turn.assistant;
  return (
    <section className="flex flex-col gap-3" data-testid="chat-turn">
      <UserBubble parts={partsOf(turn.userMessage.id)} anchorID={turn.userMessage.id}
        message={turn.userMessage as unknown as ContextPinMessage} pin={pin} />
      {settled && inline.length > 1 ? (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="self-start rounded-full bg-muted/50 px-3 py-1 text-[length:var(--type-meta)] text-muted-foreground hover:text-foreground">
          Activity ({inline.length}) {open ? 'âˆ’' : '+'}
        </button>
      ) : null}
      {open ? inline.map((message) => (
        <AssistantRow key={message.id} message={message} parts={partsOf(message.id)} anchorID={message.id} live={tailID === message.id ? false : message.time.completed === undefined} pin={pin} />
      )) : null}
    </section>
  );
}

function presentationOf(message: import('../lib/nnd/types.ts').Message): import('../lib/nnd/types.ts').PresentationMessage {
  return message as unknown as import('../lib/nnd/types.ts').PresentationMessage;
}

function UserBubble({ parts, anchorID, message, pin }: { parts: PartLite[]; anchorID: string;
  message: ContextPinMessage; pin: ContextPinTarget }): ReactNode {
  const markdown = useSettingsStore(state => state.doc.userMessageRenderingMode !== 'plain');
  const text = parts.filter((part) => part.type === 'text' && !part.synthetic && !part.ignored).map((part) => part.text ?? '').join('');
  // A shell line keeps mono inside the same bubble recipe, so the row stays one shape.
  const shellLine = text.startsWith('!') || text.startsWith('/');
  return (
    <div id={`message-${anchorID}`} className="flex scroll-mt-16 items-start justify-end gap-1">
      <div className={`ui-bubble-user max-w-[85%] text-[length:var(--type-markdown)] ${shellLine ? 'font-mono' : ''}`}>
        {text.startsWith('!') ? <span aria-hidden className="mr-1 text-tone-warning">$</span> : null}
        {markdown && text && !shellLine ? renderMarkdown(text) : <span className="whitespace-pre-wrap">{text || '[No text content]'}</span>}
      </div>
      <ContextPinButton pin={pin} message={message} variant="user" />
    </div>
  );
}

function AssistantRow({ message, parts, live, anchorID, pin }: { message: import('../lib/nnd/types.ts').PresentationMessage; parts: PartLite[]; live: boolean; anchorID?: string; pin: ContextPinTarget }): ReactNode {
  const visible = parts.filter((part) => !SKIP_KIND.has(part.type) && !part.synthetic && !part.ignored);
  return (
    <article id={anchorID ? `message-${anchorID}` : undefined} className="flex flex-col gap-1 scroll-mt-16" data-testid="chat-assistant-row">
      {visible.map((part, index) => <PartView key={index} part={part} sessionID={pin.sessionID} directory={pin.directory} messageId={message.id} />)}
      {message.error ? <ErrorCallout message={message.error} /> : null}
      <footer className="flex items-center gap-2 px-1 text-[length:var(--type-micro)] text-muted-foreground">
        <span>{[message.modelID, message.providerID].filter(Boolean).join(' · ')}</span>
        <span>{formatDuration(message.time.created, message.time.completed)}</span>
        <span>{formatRelative(message.time.completed ?? message.time.created)}</span>
        {live ? <span className="text-tone-warning/70">{workingPhrase(message.id)}…</span> : null}
        <ContextPinButton pin={pin} message={message as unknown as ContextPinMessage} variant="assistant" />
      </footer>
    </article>
  );
}

const SKIP_KIND = new Set(['step-start', 'step-finish', 'patch']);

function PartView({ part, sessionID, directory, messageId }: { part: PartLite; sessionID: string; directory: string; messageId: string }): ReactNode {
  switch (part.type) {
    case 'text':
      return <MarkdownTextView text={typeof part.text === 'string' ? part.text : ''} sessionID={sessionID} directory={directory} messageId={messageId} drawBlocks />;
    case 'reasoning':
      return <ReasoningBlock body={typeof part.text === 'string' ? part.text : ''} />;
    case 'tool':
      return <ToolCard part={part} />;
    case 'subtask':
      return <SubtaskCard description={typeof part.description === 'string' ? part.description : ''} />;
    case 'file':
      return <span className="text-[length:var(--type-meta)] text-muted-foreground">[attachment {String((part as { filename?: string }).filename ?? 'file')}]</span>;
    default:
      return null; // unknown part types never throw and never render (doc 05 §0.3)
  }
}

const IMAGE_SOURCE = /!\[[^\]]+\]\((?:"[^"]*"|'[^']*'|[^)\s]+)\)/gu;

function localImageSources(text: string): string[] {
  const sources = new Set<string>();
  for (const match of text.matchAll(IMAGE_SOURCE)) {
    const source = match[0].slice(match[0].indexOf('(') + 1, -1).replace(/^["']|["']$/g, '');
    if (!source.startsWith('http://') && !source.startsWith('https://') && !source.startsWith('data:image/')) sources.add(source);
  }
  return [...sources];
}

function MarkdownTextView({ text, sessionID, directory, messageId, drawBlocks = false }: {
  text: string; sessionID: string; directory: string; messageId: string; drawBlocks?: boolean;
}): ReactNode {
  const sources = localImageSources(text);
  const [prepared, setPrepared] = useState<Map<string, PreparedMarkdownImage>>(new Map());
  const requestKey = JSON.stringify([directory, messageId, sessionID, sources]);
  useEffect(() => {
    if (sources.length === 0) {
      setPrepared(new Map());
      return;
    }
    let active = true;
    void prepareLocalMarkdownImages({ sessionId: sessionID, directory, messageId, sources })
      .then((images) => { if (active) setPrepared(images); });
    return () => { active = false; };
  }, [requestKey]);
  const blocks = drawBlocks ? { blocks: {} } : {};
  return <div className="flex flex-col gap-1.5">{renderMarkdown(text, prepared, blocks)}</div>;
}

function ReasoningBlock({ body }: { body: string }): ReactNode {
  const [open, setOpen] = useState(false);
  // Reasoning is a disclosure block with the same geometry as a tool call, so
  // the reader learns one fold, not several.
  return (
    <Disclosure title="Reasoning" open={open} onToggle={() => setOpen(!open)}>
      <p className="whitespace-pre-wrap text-[length:var(--type-meta)] leading-[var(--type-line)] text-muted-foreground">{body}</p>
    </Disclosure>
  );
}

function SubtaskCard({ description }: { description: string }): ReactNode {
  // A delegated task is a labelled row like any other status surface value,
  // in the info tone because it names work the agent handed away.
  return (
    <Box>
      <Row label={`Delegated task${description ? ` — ${description}` : ''}`} />
    </Box>
  );
}

function ErrorCallout({ message }: { message: { name?: string; message?: string; data?: { message?: string } } | undefined }): ReactNode {
  const bag = (message ?? {}) as { name?: string; message?: string; data?: { message?: string } };
  const detail = bag.data?.message ?? bag.message ?? bag.name ?? 'unknown';
  return (
    <div data-testid="chat-error-callout">
      {/* The tone comes from the message's structured error, never from its text. */}
      <Callout tone="error" title="Unable to respond.">
        <span className="font-mono">{detail}</span>. Nothing is lost — retry when it is back.
      </Callout>
    </div>
  );
}

function StreamingTailRow({ parts, messageID, sessionID, directory }: { parts: PartLite[]; messageID: string; sessionID: string; directory: string }): ReactNode {
  const live = assistantLiveStatus(() => parts, messageID);
  const phrase = live ? (live.kind === 'thinking' ? 'thinking' : live.kind === 'tool' ? toolPhrase(live.tool) : 'composing') : workingPhrase(messageID);
  const visible = parts.filter((part) => !SKIP_KIND.has(part.type) && !part.synthetic && !part.ignored);
  // A live row wears the sheen while the turn runs; reduced motion drops it.
  return (
    <article className="ui-box relative overflow-hidden" data-testid="chat-streaming-tail" data-streaming="true">
      <div className="mb-[var(--space-1)] flex items-center gap-2 text-[length:var(--type-micro)] uppercase tracking-wide text-tone-warning">
        <Dot color="var(--tone-warning)" />
        <span className="ui-live-shine">{phrase}</span>
      </div>
      <div className="flex flex-col gap-2">
        {visible.map((part, index) => <PartView key={index} part={part} sessionID={sessionID} directory={directory} messageId={messageID} />)}
        {visible.every((part) => part.type !== 'text') ? <StreamPlaceholder /> : null}
      </div>
    </article>
  );
}

/** A live process state is a pulsing dot, not a bouncing glyph row. */
function StreamPlaceholder(): ReactNode {
  return <div className="flex items-center gap-1.5" aria-hidden><span className="ui-dot h-1.5 w-1.5 animate-pulse" /><span className="ui-dot h-1.5 w-1.5 animate-pulse [animation-delay:120ms]" /><span className="ui-dot h-1.5 w-1.5 animate-pulse [animation-delay:240ms]" /></div>;
}

/**
 * Working / waiting / retry chip above the composer (§E.1 derivation).
 *
 * The tone comes from the structured status type: a pending request is the
 * warning tone (it waits on you), a retry also warns, and a running turn is a
 * process state. The chip is one opaque floating surface, because it sits over
 * a streaming transcript on every frame.
 */
export function StatusChip({ store, sessionID }: { store: StoreApi<DirectoryStore>; sessionID: string | null }): ReactNode {
  const statusById = useSyncExternalStore(useGlobalSessionStatusStore.subscribe, pickStatusById);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const messageID = lastAssistantId(store, sessionID);
  const live = assistantLiveStatus((id) => (snapshot.part[id] ?? []) as PartLite[], messageID);
  const permissionPending = sessionID ? (snapshot.permission[sessionID]?.length ?? 0) > 0 : false;
  const questionPending = sessionID ? (snapshot.question[sessionID]?.length ?? 0) > 0 : false;
  const status: SessionStatus | undefined = sessionID ? statusById[sessionID] : undefined;
  const chip = 'absolute bottom-full left-[var(--space-4)] mb-[var(--space-2)] inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-[var(--space-3)] py-1 text-[length:var(--type-meta)]';
  if (permissionPending || questionPending) {
    return (
      <Floating>
        <aside data-testid="status-chip" data-waiting="true" aria-live="assertive" data-tone="warning" className={`${chip} bg-tone-warning/15 text-tone-warning`}>Waiting for you — respond to the request above</aside>
      </Floating>
    );
  }
  if (status?.type === 'retry') {
    return (
      <Floating>
        <aside data-testid="status-chip" data-tone="warning" className={`${chip} bg-tone-warning/20 text-tone-warning`}>{formatRetryCountdown(status.next ?? 0)} (attempt {status.attempt}): {status.message}</aside>
      </Floating>
    );
  }
  if (status?.type === 'busy') {
    const working = live?.kind === 'thinking' ? 'thinking' : live?.kind === 'tool' ? toolPhrase(live.tool) : live?.kind === 'composing' ? 'composing' : workingPhrase(messageID ?? 'idle');
    const source = isNnaActivitySource(store) ? 'NNA' : 'mock-smart';
    return (
      <Floating>
        <aside data-testid="status-chip" className={`${chip} text-muted-foreground`}>{source} is {working}<BusyDots /></aside>
      </Floating>
    );
  }
  return null;
}

function pickStatusById(): Record<string, SessionStatus> {
  return useGlobalSessionStatusStore.getState().statusById;
}

function BusyDots(): ReactNode {
  return (
    <span className="ml-1 inline-flex gap-0.5" aria-hidden>
      <span className="ui-dot h-1 w-1 animate-pulse" />
      <span className="ui-dot h-1 w-1 animate-pulse [animation-delay:120ms]" />
      <span className="ui-dot h-1 w-1 animate-pulse [animation-delay:240ms]" />
    </span>
  );
}

function lastAssistantId(store: StoreApi<DirectoryStore>, sessionID: string | null): string | undefined {
  if (!sessionID) return undefined;
  const messages = store.getState().message[sessionID] ?? [];
  const trailing = messages.at(-1);
  return trailing && trailing.role === 'assistant' && trailing.time.completed === undefined ? trailing.id : undefined;
}

