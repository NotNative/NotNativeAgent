// SPDX-License-Identifier: Apache-2.0
/**
 * Tool card catalog (doc 05 §C chat parts, SECTION-3 §3.2 parts row; W-17):
 * running/pending/settled/error states toward OC `chat/message/parts/*`
 * (read-only reference — reimplemented in this repo's style). The body is an
 * expandable JSON summary (summary/formatted/raw mirroring the
 * `toolJsonViewMode` setting), a live `state.output` block for bash runs, and
 * a settled output block. Unknown/stateless parts never throw (doc 05 §0.3).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { toolPhrase, type PartLite } from './turns.ts';
import { useSettingsStore, settingsValue } from '../lib/settings/store.ts';
import { MarkdownBlockView, markdownBlocks } from './markdown-lite.tsx';

type ToolStateLite = {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  raw?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
};

type ToolPartLite = { type: string; tool?: string; callID?: string; state?: ToolStateLite };

type JsonViewMode = 'summary' | 'formatted' | 'raw';

/** Mirror of the registry `toolJsonViewMode` (doc 14 chat settings). */
function useJsonViewMode(): JsonViewMode {
  const stored = useSettingsStore((state) => state.doc['toolJsonViewMode']);
  return stored === 'formatted' || stored === 'raw' ? (stored as JsonViewMode) : 'summary';
}

export function ToolCard({ part }: { part: PartLite }): ReactNode {
  const [open, setOpen] = useState(false);
  const preference = useJsonViewMode();
  const state = (part.state ?? {}) as ToolStateLite;
  const status = state.status ?? 'pending';
  const running = status === 'running' || status === 'pending';
  const failed = status === 'error' || status === 'failed' || status === 'aborted';
  const hasOutput = typeof state.output === 'string' && state.output.length > 0;
  const liveOutput = running && hasOutput;
  const [viewMode, setViewMode] = useState<JsonViewMode | null>(null);
  const mode = viewMode ?? preference;
  return (
    <section
      className={`overflow-hidden rounded-lg border ${failed ? 'border-red-900/40 bg-red-950/20' : running ? 'border-amber-800/40 bg-neutral-900/70' : 'border-white/10 bg-neutral-900/70'}`}
      data-testid="chat-tool-card"
      data-tool-state={failed ? 'error' : running ? 'running' : 'completed'}
      data-tool={String(part.tool ?? 'tool')}
    >
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="flex min-w-0 items-center gap-2 text-[12px] text-neutral-300">
          <span aria-hidden className={running ? 'text-amber-300' : failed ? 'text-red-400' : 'text-neutral-400'}>{running ? '⏳' : failed ? '⚠' : '🔧'}</span>
          <span className="truncate">{toolPhrase(String(part.tool ?? 'tool'))}</span>
          <StateBadge status={status} />
        </span>
        <span className="flex items-center gap-2 text-[10px] text-neutral-600">
          <Duration state={state} />
          {open ? 'hide' : 'show'}
        </span>
      </button>
      {liveOutput ? <LiveOutput output={String(state.output ?? '')} /> : null}
      {open ? (
        <div className="border-t border-white/10">
          {failed ? <ErrorLine error={String(state.error ?? 'the tool reported an error')} /> : null}
          <ToolDetail state={state} mode={mode} failed={failed} />
          <div className="flex items-center gap-1 border-t border-white/10 px-3 py-1 text-[10px] text-neutral-500">
            <span>detail</span>
            {(['summary', 'formatted', 'raw'] as JsonViewMode[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => setViewMode(candidate)}
                className={`rounded px-1.5 py-0.5 ${mode === candidate ? 'bg-white/10 text-neutral-200' : 'hover:text-neutral-300'}`}
                aria-pressed={mode === candidate}
              >
                {candidate}
              </button>
            ))}
            {part.callID ? <span className="ml-auto truncate font-mono opacity-50">{String(part.callID)}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StateBadge({ status }: { status: string }): ReactNode {
  if (status === 'running' || status === 'pending') {
    return <span className="animate-pulse rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">running</span>;
  }
  if (status === 'error' || status === 'failed' || status === 'aborted') {
    return <span className="rounded bg-red-600/20 px-1.5 py-0.5 text-[10px] text-red-300">error</span>;
  }
  return <span className="rounded bg-emerald-700/25 px-1.5 py-0.5 text-[10px] text-emerald-300">done</span>;
}

function Duration({ state }: { state: ToolStateLite }): ReactNode {
  const end = state.time?.end;
  if (typeof end !== 'number' || typeof state.time?.start !== 'number') return null;
  const ms = Math.max(0, end - state.time.start);
  return <span>{ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}</span>;
}

/** Live bash echo (§5.2.3 deltas → state.output): trailing block, ~6 lines. */
function LiveOutput({ output }: { output: string }): ReactNode {
  const lines = output.split('\n');
  const tail = lines.slice(-8);
  return (
    <pre className="border-t border-white/10 bg-neutral-950/80 px-3 py-2 font-mono text-[11px] leading-5 text-emerald-200/90" data-testid="chat-tool-live-output">
      {(tail.length < lines.length ? ['…'] : []).concat(tail).join('\n')}
    </pre>
  );
}

function ErrorLine({ error }: { error: string }): ReactNode {
  return <div className="px-3 py-2 text-[11px] leading-5 text-red-300" data-testid="chat-tool-error">{error}</div>;
}

/** Summary / formatted / raw detail body. Shared pipeline for JSON views. */
function ToolDetail({ state, mode, failed }: { state: ToolStateLite; mode: JsonViewMode; failed: boolean }): ReactNode {
  if (mode === 'formatted') {
    return (
      <pre className="max-h-72 overflow-auto px-3 py-2 text-[11px] leading-5 text-neutral-300">
        {JSON.stringify(state, null, 2)}
      </pre>
    );
  }
  if (mode === 'raw') {
    return (
      <pre className="max-h-72 overflow-auto px-3 py-2 text-[11px] leading-5 text-neutral-400">
        {typeof state.raw === 'string' && state.raw ? state.raw : JSON.stringify(state.input ?? {}, null, 0)}
      </pre>
    );
  }
  return <ToolSummary state={state} failed={failed} />;
}

function scalarRowsOf(input: Record<string, unknown>, priority: string[]): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const key of priority) {
    if (input[key] === undefined || input[key] === '') continue;
    rows.push([key, previewValue(input[key])]);
  }
  return rows;
}

function previewValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'undefined';
}

function ToolSummary({ state, failed }: { state: ToolStateLite; failed: boolean }): ReactNode {
  const input = (state.input ?? {}) as Record<string, unknown>;
  const metadata = state.metadata ?? {};
  const rows = scalarRowsOf(input, ['path', 'filePath', 'command', 'pattern', 'query', 'url', 'file_path', 'description']);
  return (
    <div className="max-h-72 space-y-2 overflow-auto px-3 py-2">
      {typeof state.title === 'string' && state.title ? <div className="text-[11.5px] text-neutral-200">{state.title}</div> : null}
      {rows.map(([key, value]) => (
        <div key={key} className="flex gap-2 text-[11px] leading-5">
          <span className="w-16 shrink-0 text-neutral-600">{key}</span>
          <span className={`min-w-0 font-mono ${key === 'command' ? 'break-all text-amber-200' : 'break-all text-neutral-300'}`}>{value}</span>
        </div>
      ))}
      {typeof state.output === 'string' && state.output && !failed ? <SettledOutput output={state.output} /> : null}
      <MetadataSummary metadata={metadata} />
    </div>
  );
}

/** Settled output: fenced blocks render, everything else is pre-wrapped text. */
function SettledOutput({ output }: { output: string }): ReactNode {
  const blocks = useMemo(() => markdownBlocks(output), [output]);
  return (
    <div data-testid="chat-tool-output" className="rounded border border-white/10 bg-neutral-950/70 p-2">
      {blocks.slice(0, 6).map((block, at) => <MarkdownBlockView key={at} block={block} />)}
      {blocks.length > 6 ? <div className="px-1 pt-1 text-[10px] text-neutral-600">+ {blocks.length - 6} more block(s)</div> : null}
    </div>
  );
}

function MetadataSummary({ metadata }: { metadata: Record<string, unknown> }): ReactNode {
  const entries = Object.entries(metadata).filter(([, value]) => typeof value !== 'object' || value === null);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pt-0.5" data-testid="chat-tool-metadata">
      {entries.slice(0, 6).map(([key, value]) => (
        <span key={key} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400">
          {key}: {previewValue(value)}
        </span>
      ))}
    </div>
  );
}

/** Read side used by callers other than the transcript (kept tiny). */
export function jsonViewModeFromSettings(): JsonViewMode {
  const read = settingsValue('toolJsonViewMode') as string | undefined;
  return read === 'formatted' || read === 'raw' ? read : 'summary';
}

export type { ToolPartLite };
