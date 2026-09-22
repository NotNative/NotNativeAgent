// SPDX-License-Identifier: Apache-2.0
/**
 * Blocking cards (doc 05 §F). Permission cards (§F.2): per-tool bodies —
 * bash command highlight, edit path/replace-all note + diff preview, write
 * content, webfetch method+URL, generic fallback, patterns chips; actions
 * Allow once/Always/Deny; keyboard newest-card-only stack: Alt+Enter=once,
 * Alt+Shift+Enter=always, Alt+Backspace=reject (capture phase). Question
 * cards (§F.3): tab strip Q1..Qn + Summary when >1, "Other…" free-text for
 * custom questions, Next jumps to the first unanswered, Enter submits when
 * complete, copied serializers, submit/deny flows with stale-request and
 * transmit toasts. Send-while-blocked sends are composer/planner-owned (§F.4).
 */
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { PermissionRequest, QuestionRequest } from '../lib/nnd/types.ts';
import { toast } from 'sonner';

interface ColumnProps {
  store: StoreApi<DirectoryStore>;
  engine: SyncEngine;
  sessionID: string;
}

/** §F.1: transcript-footer column, current session scope. */
export function BlockingCardsColumn({ store, engine, sessionID }: ColumnProps): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const permissions = snapshot.permission[sessionID] ?? [];
  const questions = snapshot.question[sessionID] ?? [];
  if (permissions.length === 0 && questions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="blocking-cards" onKeyDown={(event) => {
      if (!event.altKey || permissions.length === 0) return;
      const newest = permissions.at(-1) as PermissionRequest | undefined;
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

// ── permission cards (§F.2) ────────────────────────────────────────────────

const TOOL_LABEL: Record<string, string | undefined> = { bash: 'Bash', edit: 'Edit', write: 'Write', webfetch: 'Web fetch', read: 'Read' };

function PermissionCardView({ request, engine, sessionID }: { request: PermissionRequest; engine: SyncEngine; sessionID: string }): ReactNode {
  const tool = String(request.permission ?? 'tool');
  return (
    <section className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3" data-testid="permission-card" data-permission-tool={tool}>
      <header className="mb-1 flex items-center gap-2 text-[12px] text-amber-200">
        <span aria-hidden>⚠️</span>
        <strong className="font-medium">Permission Required</strong>
        <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px]">{TOOL_LABEL[tool] ?? tool}</span>
      </header>
      <PermissionCardBody request={request} tool={tool} />
      <PatternsLine patterns={request.patterns} />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" data-testid="permission-allow-once" className="rounded bg-emerald-600/80 px-2 py-1 text-[11px] text-white" onClick={() => void engine.actions.replyPermission(sessionID, request, 'once')}>Allow once</button>
        <button type="button" data-testid="permission-allow-always" className="rounded bg-sky-700/70 px-2 py-1 text-[11px] text-white" onClick={() => void engine.actions.replyPermission(sessionID, request, 'always')}>Always allow</button>
        <button type="button" data-testid="permission-deny" className="rounded bg-red-900/60 px-2 py-1 text-[11px] text-red-200" onClick={() => void engine.actions.replyPermission(sessionID, request, 'reject')}>Deny</button>
        <span className="ml-auto text-[10px] text-neutral-600">Alt+Enter once · Alt+Shift+Enter always · Alt+Backspace deny</span>
      </div>
    </section>
  );
}

function metadataOf(request: PermissionRequest): Record<string, unknown> {
  return (request.metadata ?? {}) as Record<string, unknown>;
}

function PermissionCardBody({ request, tool }: { request: PermissionRequest; tool: string }): ReactNode {
  const metadata = metadataOf(request);
  if (tool === 'bash' || tool === 'command') {
    return (
      <div className="mb-2 space-y-1">
        <pre className="rounded border border-amber-800/40 bg-neutral-950/60 px-2 py-1.5 font-mono text-[11px] text-amber-200">{String(metadata['command'] ?? '?')}</pre>
        <BashMetaRows metadata={metadata} />
      </div>
    );
  }
  if (tool === 'edit') {
    return (
      <div className="mb-2 space-y-1">
        {metadata['replaceAll'] ? <div className="text-[11px] text-amber-300">⚠️ Replace All Occurrences</div> : null}
        <div className="font-mono text-[11px] text-neutral-300">{String(metadata['path'] ?? '')}</div>
        <DiffPreviewBlock diff={typeof metadata['diff'] === 'string' ? String(metadata['diff']) : typeof metadata['changes'] === 'string' ? String(metadata['changes']) : ''} />
      </div>
    );
  }
  if (tool === 'write') return <WriteBody metadata={metadata} />;
  if (tool === 'webfetch') return <WebFetchBody metadata={metadata} />;
  const description = typeof metadata['description'] === 'string' ? String(metadata['description']) : '';
  return (
    <div className="mb-2 space-y-1 text-[11px] text-neutral-300">
      {description ? <div>{description}</div> : null}
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-neutral-950/50 px-2 py-1 text-[11px] text-neutral-400">{JSON.stringify(metadata, null, 2)}</pre>
    </div>
  );
}

function BashMetaRows({ metadata }: { metadata: Record<string, unknown> }): ReactNode {
  const rows: string[] = [];
  if (typeof metadata['cwd'] === 'string' && metadata['cwd']) rows.push(`working directory ${metadata['cwd']}`);
  if (typeof metadata['timeoutMs'] === 'number') rows.push(`timeout ${metadata['timeoutMs']}ms`);
  if (typeof metadata['description'] === 'string' && metadata['description']) rows.push(String(metadata['description']));
  if (rows.length === 0) return null;
  return <div className="text-[10px] text-neutral-500">{rows.join(' · ')}</div>;
}

function DiffPreviewBlock({ diff }: { diff: string }): ReactNode {
  if (!diff.trim()) return null;
  return <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-neutral-950/50 px-2 py-1 text-[10.5px] text-neutral-300">{diff.slice(0, 4000)}</pre>;
}

function WriteBody({ metadata }: { metadata: Record<string, unknown> }): ReactNode {
  const content = typeof metadata['content'] === 'string' ? String(metadata['content']) : '';
  return (
    <div className="mb-2 space-y-1">
      <div className="font-mono text-[11px] text-neutral-300">{String(metadata['path'] ?? '')}</div>
      {content ? <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-neutral-950/50 px-2 py-1 text-[10.5px] text-neutral-400">{content.slice(0, 4000)}</pre> : null}
    </div>
  );
}

function WebFetchBody({ metadata }: { metadata: Record<string, unknown> }): ReactNode {
  return (
    <div className="mb-2 space-y-1 text-[11px] text-neutral-300">
      <div className="flex items-center gap-2">
        {metadata['method'] ? <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px]">{String(metadata['method'])}</span> : null}
        <span className="min-w-0 truncate font-mono">{String(metadata['url'] ?? '')}</span>
      </div>
      {metadata['headers'] ? <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-words text-[10.5px] text-neutral-500">{JSON.stringify(metadata['headers'], null, 2)}</pre> : null}
      {typeof metadata['body'] === 'string' && metadata['body'] ? <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-words text-[10.5px] text-neutral-500">{String(metadata['body'])}</pre> : null}
    </div>
  );
}

function PatternsLine({ patterns }: { patterns: string[] }): ReactNode {
  if (patterns.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] text-neutral-500">
      <span>Patterns:</span>
      {patterns.slice(0, 8).map((pattern) => <span key={pattern} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-neutral-300">{pattern}</span>)}
    </div>
  );
}

// ── question cards (§F.3) ───────────────────────────────────────────────────

function QuestionCardView({ request, engine, sessionID }: { request: QuestionRequest; engine: SyncEngine; sessionID: string }): ReactNode {
  const multi = request.questions.length > 1;
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ''));
  const [tab, setTab] = useState(multi ? 0 : -1);
  const questions = request.questions;
  const answered = (index: number): boolean => (answers[index]?.length ?? 0) > 0 || (questions[index]?.custom === true && (custom[index] ?? '').trim() !== '');
  const allAnswered = questions.length === 0 || questions.every((_, index) => answered(index));

  const submit = (reject: boolean): void => {
    const payload = reject ? [] : questions.map((question, index) => {
      const text = (custom[index] ?? '').trim();
      return question.custom === true && text !== '' ? [text] : (answers[index] ?? []);
    });
    void engine.actions.replyQuestion(sessionID, request, payload, reject)
      .then(() => { if (!reject) toast.success('Response sent'); })
      .catch((error: unknown) => {
        const status = (error as { status?: number })?.status;
        if (status === 404) toast.error('This question is no longer waiting for a response.');
        else toast.error('Failed to send response. Please try again in a moment.');
      });
  };

  const nextUnanswered = (): void => {
    if (!multi) return;
    const start = tab >= 0 ? Math.min(tab, questions.length) : -1;
    for (let step = 1; step <= questions.length; step += 1) {
      const candidate = ((start + step) % questions.length + questions.length) % questions.length;
      if (!answered(candidate)) { setTab(candidate); return; }
    }
  };

  return (
    <section className="rounded-lg border border-indigo-800/50 bg-indigo-950/20 p-3" data-testid="question-card" data-question-id={request.id}>
      <header className="mb-1 flex items-center gap-2 text-[12px] text-indigo-200">
        <strong className="font-medium">Input needed</strong>
        <span className="ml-auto text-[10px] text-neutral-600">{allAnswered ? 'ready to send' : questions.length === 1 ? 'answer the question' : `${answers.filter((answer, index) => answered(index)).length}/${questions.length} answered`}</span>
      </header>
      {multi ? <Tabs questions={questions} answers={answers} custom={custom} tab={tab} onTab={setTab} answered={answered} /> : null}
      {tab === -1 && multi ? <SummaryTab questions={questions} answers={answers} custom={custom} onTab={setTab} /> : null}
      {tab !== -1 || !multi ? (
        questions.filter((_, index) => !multi || index === tab).map((question, index) => {
          const actual = multi ? tab : index;
          if (actual < 0 || actual >= questions.length) return null;
          return (
            <QuestionBlock
              key={actual}
              question={question}
              picked={answers[actual] ?? []}
              customText={custom[actual] ?? ''}
              onPick={(labels) => setAnswers(answers.map((answer, at) => (at === actual ? labels : answer)))}
              onCustom={(text) => setCustom(custom.map((entry, at) => (at === actual ? text : entry)))}
            />
          );
        })
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" disabled={!allAnswered} data-testid="question-submit" className="rounded bg-white/90 px-2 py-1 text-[11px] font-medium text-black disabled:opacity-40" onClick={() => submit(false)}>Submit</button>
        {multi ? <button type="button" data-testid="question-next" className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300" onClick={nextUnanswered}>Next</button> : null}
        <button type="button" data-testid="question-dismiss" className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300" onClick={() => submit(true)}>Dismiss</button>
        <span className="ml-auto flex gap-1 text-[10px] text-neutral-600">
          <button type="button" className="hover:text-neutral-300" onClick={() => void copyQuestion(request, 'markdown')}>Copy md</button>
          <button type="button" className="hover:text-neutral-300" onClick={() => void copyQuestion(request, 'json')}>Copy json</button>
        </span>
      </div>
    </section>
  );
}

function Tabs({ questions, answers, custom, tab, onTab, answered }: {
  questions: QuestionRequest['questions'];
  answers: string[][];
  custom: string[];
  tab: number;
  onTab: (at: number) => void;
  answered: (index: number) => boolean;
}): ReactNode {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1" data-testid="question-tabs">
      {questions.map((question, index) => (
        <button key={index} type="button" onClick={() => onTab(index)} aria-pressed={tab === index}
          className={`rounded px-2 py-0.5 text-[11px] ${tab === index ? 'bg-indigo-700/60 text-neutral-100' : 'bg-neutral-900/60 text-neutral-400 hover:text-neutral-200'}`}>
          Q{index + 1} {question.header || `Question ${index + 1}`}{answered(index) ? ' ✓' : ''}
        </button>
      ))}
      <button type="button" onClick={() => onTab(-1)} aria-pressed={tab === -1}
        className={`rounded px-2 py-0.5 text-[11px] ${tab === -1 ? 'bg-indigo-700/60 text-neutral-100' : 'bg-neutral-900/60 text-neutral-400 hover:text-neutral-200'}`}>
        Summary
      </button>
    </div>
  );
}

function SummaryTab({ questions, answers, custom, onTab }: { questions: QuestionRequest['questions']; answers: string[][]; custom: string[]; onTab: (at: number) => void }): ReactNode {
  return (
    <div className="mb-2 space-y-1 rounded border border-white/10 bg-neutral-900/60 p-2" data-testid="question-summary">
      {questions.map((question, index) => (
        <div key={index} className="flex items-center gap-2 text-[11px]">
          <button type="button" className="text-indigo-300 hover:text-indigo-200" onClick={() => onTab(index)}>{question.header || `Q${index + 1}`}</button>
          <span className="min-w-0 flex-1 truncate text-neutral-500">{question.custom === true && (custom[index] ?? '').trim() !== '' ? (custom[index] ?? '').trim() : (answers[index] ?? []).join(', ') || '—'}</span>
        </div>
      ))}
    </div>
  );
}

function QuestionBlock({ question, picked, customText, onPick, onCustom }: {
  question: { multiple?: boolean; custom?: boolean; header: string; question: string; options: Array<{ label: string; description: string }> };
  picked: string[];
  customText: string;
  onPick: (labels: string[]) => void;
  onCustom: (text: string) => void;
}): ReactNode {
  return (
    <div className="mb-2">
      <div className="text-[12px] font-medium text-neutral-200">{question.header || 'Question'}</div>
      {question.question ? <p className="whitespace-pre-wrap text-[12px] text-neutral-400">{question.question}</p> : null}
      <div className="mt-1 flex flex-col gap-1">
        {(question.options ?? []).map((option) => (
          <label key={option.label} className="flex cursor-pointer items-center gap-2 text-[12px] text-neutral-300">
            <input
              type={question.multiple === true ? 'checkbox' : 'radio'}
              checked={picked.includes(option.label)}
              onChange={() => onPick(question.multiple === true
                ? (picked.includes(option.label) ? picked.filter((x) => x !== option.label) : [...picked, option.label])
                : (picked[0] === option.label ? [] : [option.label]))}
            />
            {option.label}{option.description ? <span className="text-neutral-600">— {option.description}</span> : null}
          </label>
        ))}
        {question.custom === true ? (
          <textarea
            rows={2}
            data-testid={`question-custom-${question.header || 'other'}`}
            placeholder="Other…"
            value={customText}
            onChange={(event) => onCustom(event.target.value)}
            className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-neutral-900 p-2 text-[12px] text-neutral-200 outline-none focus:border-white/25"
          />
        ) : null}
      </div>
    </div>
  );
}

async function copyQuestion(request: QuestionRequest, format: 'markdown' | 'json'): Promise<void> {
  const text = format === 'json' ? JSON.stringify(request.questions, null, 2) : request.questions
    .map((question, index) => `## Q${index + 1} ${question.header || ''}\n${question.question ?? ''}\n${(question.options ?? []).map((option) => `- ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')}`)
    .join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Question copied as ${format === 'json' ? 'JSON' : 'Markdown'}`);
  } catch {
    toast.error('Failed to copy question');
  }
}
