// SPDX-License-Identifier: Apache-2.0
/**
 * Transcript (doc 05 §C, v1): turn projection render, streaming tail, part
 * dispatch, tool cards (plain bodies; rich diff lands with P6), facts footer,
 * error callouts, status chip (§E.1), and §F blocking cards.
 */
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { AssistantMessage, PermissionRequest, QuestionRequest, SessionStatus } from '../lib/nnd/types.ts';
import type { DirectoryStore } from '../sync/types.ts';
import { useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { projectTurns, streamingTail, turnSettled, assistantLiveStatus, toolPhrase, workingPhrase, type PartLite, type ChatTurn } from './turns.ts';
import { formatDuration, formatRelative, formatRetryCountdown } from './time-format.ts';

export interface TranscriptProps {
  store: StoreApi<DirectoryStore>;
  engine: SyncEngine;
  sessionID: string | null;
  directory: string;
}

export function Transcript(props: TranscriptProps): ReactNode {
  const { store, engine, sessionID, directory } = props;
  void directory;
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  if (!sessionID) {
    return <div className="mx-auto max-w-xl px-6 py-16 text-center text-sm text-neutral-600" data-testid="chat-empty">No session selected — open the sidebar to start.</div>;
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
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6" data-testid="chat-transcript">
      {turns.map((turn, index) => (
        <TurnRow key={`${turn.userMessage.id}-${index}`} turn={turn} store={store} engine={engine} tailID={index === lastIndex ? tail?.id : undefined} />
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
          Activity ({inline.length}) {open ? '−' : '+'}
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
      return <p className="whitespace-pre-wrap break-words text-sm leading-6 text-neutral-200">{part.text ?? ''}</p>;
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
        Reasoning {open ? '−' : '+'}
      </button>
      {open ? <p className="whitespace-pre-wrap text-[13px] leading-6 text-neutral-400">{body}</p> : null}
    </div>
  );
}

function ToolCard({ part }: { part: PartLite }): ReactNode {
  const [open, setOpen] = useState(false);
  const running = part.state?.status === 'running' || part.state?.status === 'pending';
  const state = part.state as { input?: unknown; output?: unknown } | undefined;
  const detail = typeof state?.output === 'string' && state.output.length > 0 ? state.output : JSON.stringify(state?.input ?? {}, null, 2);
  return (
    <section className="rounded-lg border border-white/10 bg-neutral-900/70" data-testid="chat-tool-card">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="text-[12px] text-neutral-300">
          <span aria-hidden className="mr-2">{running ? '⏳' : '🔧'}</span>
          {toolPhrase(String(part.tool ?? 'tool'))}
        </span>
        <span className="text-[10px] text-neutral-600">{open ? 'hide' : 'show'}</span>
      </button>
      {open ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-white/10 px-3 py-2 text-[11px] leading-5 text-neutral-400">{detail}</pre> : null}
    </section>
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
  const text = parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
  const live = assistantLiveStatus(() => parts, messageID);
  const phrase = live ? (live.kind === 'thinking' ? 'thinking' : live.kind === 'tool' ? toolPhrase(live.tool) : 'composing') : workingPhrase(messageID);
  return (
    <article className="rounded-lg bg-neutral-900/60 p-3" data-testid="chat-streaming-tail" data-streaming="true">
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-amber-400/80">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        {phrase}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-neutral-200">{text}</p>
    </article>
  );
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

/** §F blocking cards at the transcript footer, current session scope. */
function BlockingCardsColumn({ store, engine, sessionID }: { store: StoreApi<DirectoryStore>; engine: SyncEngine; sessionID: string }): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const permissions = snapshot.permission[sessionID] ?? [];
  const questions = snapshot.question[sessionID] ?? [];
  if (permissions.length === 0 && questions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="blocking-cards" onKeyDown={(event) => {
      if (!event.altKey) return;
      const newest = permissions.at(-1);
      if (!newest) return;
      event.preventDefault();
      if (event.key === 'Enter' && !event.shiftKey) void engine.actions.replyPermission(sessionID, newest, 'once');
      else if (event.key === 'Enter' && event.shiftKey) void engine.actions.replyPermission(sessionID, newest, 'always');
      else if (event.key === 'Backspace') void engine.actions.replyPermission(sessionID, newest, 'reject');
    }}>
      {permissions.map((request) => <PermissionCardView key={request.id} request={request} engine={engine} sessionID={sessionID} />)}
      {questions.map((request) => <QuestionCardView key={request.id} request={request} engine={engine} sessionID={sessionID} />)}
    </div>
  );
}

function PermissionCardView({ request, engine, sessionID }: { request: PermissionRequest; engine: SyncEngine; sessionID: string }): ReactNode {
  const tool = String(request.permission ?? 'tool');
  return (
    <section className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3" data-testid="permission-card">
      <header className="mb-1 flex items-center gap-2 text-[12px] text-amber-200">
        <strong className="font-medium">Permission Required</strong>
        <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px]">{tool}</span>
      </header>
      <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-neutral-300">{metadataPreview(request)}</pre>
      <div className="flex items-center gap-2">
        <button type="button" className="rounded bg-emerald-600/80 px-2 py-1 text-[11px] text-white" onClick={() => void engine.actions.replyPermission(sessionID, request, 'once')}>Allow once</button>
        <button type="button" className="rounded bg-sky-700/70 px-2 py-1 text-[11px] text-white" onClick={() => void engine.actions.replyPermission(sessionID, request, 'always')}>Always allow</button>
        <button type="button" className="rounded bg-red-900/60 px-2 py-1 text-[11px] text-red-200" onClick={() => void engine.actions.replyPermission(sessionID, request, 'reject')}>Deny</button>
      </div>
    </section>
  );
}

function metadataPreview(request: PermissionRequest): string {
  const bag = request as unknown as Record<string, unknown>;
  const rows: string[] = [];
  if (Array.isArray(bag['patterns'])) rows.push(`Patterns: ${(bag['patterns'] as unknown[]).join(' ')}`);
  const metadata = bag['metadata'];
  if (metadata && typeof metadata === 'object') rows.push(JSON.stringify(metadata, null, 2));
  return rows.join('\n') || 'Request payload available in the tool card.';
}

function QuestionCardView({ request, engine, sessionID }: { request: QuestionRequest; engine: SyncEngine; sessionID: string }): ReactNode {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const allAnswered = request.questions.length === 0 || request.questions.every((_, index) => (answers[index]?.length ?? 0) > 0);
  const submit = (reject: boolean): void => {
    void engine.actions.replyQuestion(sessionID, request, reject ? [] : answers, reject).catch(() => {
      import('sonner').then(({ toast }) => { toast.error('Failed to send response. Please try again in a moment.'); setTimeout(() => undefined, 0); });
    });
  };
  return (
    <section className="rounded-lg border border-indigo-800/50 bg-indigo-950/20 p-3" data-testid="question-card">
      <header className="mb-1 text-[12px] text-indigo-200"><strong className="font-medium">Input needed</strong></header>
      {request.questions.map((question, qIndex) => (
        <div key={qIndex} className="mb-2">
          <div className="text-[12px] font-medium text-neutral-200">{question.header ?? `Question ${qIndex + 1}`}</div>
          {question.question ? <p className="whitespace-pre-wrap text-[12px] text-neutral-400">{question.question}</p> : null}
          <div className="mt-1 flex flex-col gap-1">
            {(question.options ?? []).map((option) => (
              <label key={option.label} className="flex cursor-pointer items-center gap-2 text-[12px] text-neutral-300">
                <input
                  type={question.multiple === true ? 'checkbox' : 'radio'}
                  name={`q-${request.id}-${qIndex}`}
                  checked={answers[qIndex]?.includes(option.label) ?? false}
                  onChange={() => setAnswers(answers.map((answer, index) => (index === qIndex ? togglePick(answer, option.label, question.multiple === true) : answer)))}
                />
                {option.label}{option.description ? <span className="text-neutral-600">— {option.description}</span> : null}
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button type="button" disabled={!allAnswered} className="rounded bg-white/90 px-2 py-1 text-[11px] font-medium text-black disabled:opacity-40" onClick={() => submit(false)}>Submit</button>
        <button type="button" className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300" onClick={() => submit(true)}>Dismiss</button>
      </div>
    </section>
  );
}

function togglePick(current: string[], label: string, multiple: boolean): string[] {
  if (multiple) return current.includes(label) ? current.filter((x) => x !== label) : [...current, label];
  return current[0] === label ? [] : [label];
}
