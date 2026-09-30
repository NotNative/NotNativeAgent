// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cancelWalkthroughStage, fetchWalkthroughStage, generateWalkthroughPreview, loadWalkthroughPreview,
  loadWalkthroughReadiness, type GeneratedWalkthrough, type WalkthroughModelOption,
  type WalkthroughPreview, type WalkthroughReadiness, type WalkthroughScope,
  type WalkthroughSource } from '../lib/git/walkthrough-preview.ts';
import { sourceKey } from '../lib/git/walkthrough-source-store.ts';
import { useI18nStore } from '../lib/i18n/store.ts';
import { setSettingsField, useSettingsStore } from '../lib/settings/store.ts';

type SelectedSource = WalkthroughScope | WalkthroughSource;
type WalkthroughScopeAlias = WalkthroughScope;
type WalkthroughSourceAlias = WalkthroughSource;
type PreviewRecord = { directory: string; source: SelectedSource; preview: WalkthroughPreview };
type NarrativeRecord = { directory: string; source: SelectedSource; sessionId: string; value: GeneratedWalkthrough };
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;
const OWNER = /^[a-zA-Z0-9-]+$/u;
const REPOSITORY = /^[a-zA-Z0-9_.-]+$/u;
type ModelReadinessRecord = { readiness: WalkthroughReadiness; model: WalkthroughModelOption | null;
  options: WalkthroughModelOption[] };

function normalize(value: string, max = 256): string | null {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && Buffer.byteLength(trimmed, 'utf8') <= max ? trimmed : null;
}

function asWalkthroughSource(source: SelectedSource | null): WalkthroughSource | null {
  if (!source) return null;
  return typeof source === 'string' ? { kind: 'working-tree', scope: source } : source;
}

function identity(source: SelectedSource | null): string | null {
  if (!source) return null;
  return sourceKey(asWalkthroughSource(source)!);
}

function sourceIdentity(source: SelectedSource): string {
  return identity(source) ?? '';
}

function selectedPreview(record: PreviewRecord | null, directory: string, source: SelectedSource | null): WalkthroughPreview | null {
  if (!record || !source || record.directory !== directory) return null;
  return identity(record.source) === identity(source) ? record.preview : null;
}

function selectedNarrative(record: NarrativeRecord | null, directory: string, source: SelectedSource | null,
  sessionId: string | null, preview: WalkthroughPreview | null, stale: boolean): GeneratedWalkthrough | null {
  if (!record || !source || !preview || stale || record.directory !== directory || record.sessionId !== sessionId) return null;
  return identity(record.source) === identity(source) && record.value.revision === preview.signature ? record.value : null;
}

function validSource(source: SelectedSource | null): WalkthroughSource | null {
  if (!source) return null;
  if (typeof source === 'string') return { kind: 'working-tree', scope: source };
  if (source.kind === 'working-tree') return source;
  if (source.kind === 'branch') {
    const baseRef = normalize(source.baseRef);
    const headRef = normalize(source.headRef);
    return baseRef && headRef ? { kind: source.kind, baseRef, headRef } : null;
  }
  if (source.kind === 'commit') return OBJECT_ID.test(source.hash) ? source : null;
  if (!Number.isSafeInteger(source.number) || source.number < 1 || source.number > 2_147_483_647) return null;
  if (!source.sourceRepo) return source;
  const owner = source.sourceRepo.owner.trim();
  const repo = source.sourceRepo.repo.trim();
  if (!owner && !repo) return { kind: 'pr', number: source.number };
  return OWNER.test(owner) && REPOSITORY.test(repo)
    ? { kind: 'pr', number: source.number, sourceRepo: { owner, repo } } : null;
}

function useWalkthroughNarrative(directory: string, source: SelectedSource | null, sessionId: string | null,
  preview: WalkthroughPreview | null, stale: boolean, model: string): { narrative: GeneratedWalkthrough | null; generating: boolean;
  stage: string | null; error: string | null; generate: () => Promise<void>; cancel: () => Promise<void>; reset: () => void } {
  const [record, setRecord] = useState<NarrativeRecord | null>(null);
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const watching = useRef<AbortController | null>(null);
  const pendingModel = useRef<string | null>(null);
  const stopWatcher = useCallback(() => {
    const watcher = watching.current;
    watching.current = null;
    watcher?.abort();
  }, []);
  const currentId = identity(source);
  const narrative = selectedNarrative(record, directory, source, sessionId, preview, stale);
  useEffect(() => {
    stopWatcher();
    request.current += 1;
    setRecord(null); setGenerating(false); setStage(null); setError(null);
    pendingModel.current = null;
  }, [currentId, directory, preview?.signature, sessionId, stopWatcher]);
  useEffect(() => () => stopWatcher(), [stopWatcher]);
  const reset = useCallback(() => {
    stopWatcher();
    request.current += 1;
    setRecord(null);
    setGenerating(false);
    setStage(null);
    setError(null);
    pendingModel.current = null;
  }, [stopWatcher]);
  const cancel = useWalkthroughCancel({ directory, source, sessionId, preview, generating, pendingModel, request, stopWatcher,
    setGenerating, setStage, setError });
  const generate = useCallback(async () => {
    if (!sessionId || !preview || stale) return;
    const id = ++request.current;
    setGenerating(true);
    setStage('collecting');
    setError(null);
    pendingModel.current = model === '' ? null : model;
    const observing = new AbortController();
    watching.current = observing;
    void watchWalkthroughStage(directory, source, observing, id, request, setStage, pendingModel.current);
    try {
      const selected = typeof source === 'string' ? source : asWalkthroughSource(source)!;
      const value = await generateWalkthroughPreview(directory, sessionId, preview.signature, selected,
        useI18nStore.getState().locale, preview.stops, model);
      if (id === request.current) setRecord({ directory, source: source as SelectedSource, sessionId, value });
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : 'Could not generate walkthrough.');
    } finally {
      stopWatcher();
      pendingModel.current = null;
      if (id === request.current) setGenerating(false);
    }
  }, [directory, preview, sessionId, source, stale, model]);
  return { narrative, generating, stage, error, generate, cancel, reset };
}

type WalkthroughCancelConfig = {
  directory: string;
  source: SelectedSource | null;
  sessionId: string | null;
  preview: WalkthroughPreview | null;
  generating: boolean;
  pendingModel: { current: string | null };
  request: { current: number };
  stopWatcher: () => void;
  setGenerating: (value: boolean) => void;
  setStage: (value: string | null) => void;
  setError: (value: string | null) => void;
};

function useWalkthroughCancel({ directory, source, sessionId, preview, generating, pendingModel, request,
  stopWatcher, setGenerating, setStage, setError }: WalkthroughCancelConfig) {
  return useCallback(async () => {
    if (!sessionId || !preview || !generating) return;
    try {
      const selected = typeof source === 'string' ? source : asWalkthroughSource(source)!;
      const cancelled = await cancelWalkthroughStage(directory, selected, pendingModel.current);
      if (!cancelled) {
        setError('Could not cancel walkthrough generation.');
        return;
      }
      request.current += 1;
      stopWatcher();
      setGenerating(false);
      setStage(null);
      setError('Walkthrough generation cancelled.');
    } catch {
      setError('Could not cancel walkthrough generation.');
    }
  }, [directory, generating, pendingModel, preview, sessionId, source, request, stopWatcher,
    setGenerating, setStage, setError]);
}

function watchWalkthroughStage(directory: string, source: SelectedSource | null, observing: AbortController,
  id: number, request: { current: number }, setStage: (value: string | null) => void,
  model: string | null): Promise<void> {
  return (async () => {
    while (!observing.signal.aborted) {
      try {
        const selected = typeof source === 'string' ? source : asWalkthroughSource(source)!;
        const observed = await fetchWalkthroughStage(directory, selected, observing.signal, model);
        if (!observing.signal.aborted && id === request.current && observed) setStage(observed);
      } catch { /* Generation completion still owns this state. */ }
      await new Promise((resolve) => setTimeout(resolve, observing.signal.aborted ? 0 : 450));
      if (observing.signal.aborted) break;
    }
  })();
}

function useWalkthroughModelReadiness(directory: string, source: SelectedSource | null, visible: boolean,
  signature: string | null, override: string): { record: ModelReadinessRecord | null; error: boolean } {
  const [record, setRecord] = useState<ModelReadinessRecord | null>(null);
  const [error, setError] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    if (!visible || !signature || !source) {
      setRecord(null);
      setError(false);
      return () => undefined;
    }
    const selected = typeof source === 'string' ? source : asWalkthroughSource(source)!;
    const controller = new AbortController();
    void loadWalkthroughReadiness(directory, selected, override, controller.signal).then((next) => {
      if (id === request.current) {
        setRecord(next);
        setError(false);
      }
    }).catch(() => {
      if (id === request.current) {
        setRecord(null);
        setError(true);
      }
    });
    return () => {
      request.current += 1;
      controller.abort();
    };
  }, [identity(source), signature, override, directory, visible]);
  return { record, error };
}

function useWalkthroughPreview(directory: string, source: SelectedSource | null, visible: boolean): {
  preview: WalkthroughPreview | null; stale: boolean; error: string | null; refresh: () => Promise<void>;
} {
  const [record, setRecord] = useState<PreviewRecord | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const preview = selectedPreview(record, directory, source);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const capture = useCallback(async () => {
    const target = sourceRef.current;
    if (!target) return;
    const id = ++request.current;
    try {
      const selected = typeof target === 'string' ? target : target;
      const next = await loadWalkthroughPreview(directory, selected);
      if (id !== request.current) return;
      setRecord({ directory, source: selected, preview: next });
      setStale(false);
      setError(null);
    } catch (cause) {
      if (id === request.current) {
        setStale(true);
        setError(cause instanceof Error ? cause.message : 'Could not load walkthrough preview.');
      }
    } finally {
      if (id === request.current) request.current = 0;
    }
  }, [directory]);
  useEffect(() => {
    if (!visible || !source) return;
    void capture();
    return () => { request.current += 1; };
  }, [capture, identity(source), visible]);
  useEffect(() => {
    if (!visible || !preview || !source || stale) return;
    let live = true;
    let checking = false;
    const verify = (): void => {
      if (document.hidden || checking) return;
      checking = true;
      const selected = typeof source === 'string' ? source : source;
      void loadWalkthroughPreview(directory, selected).then((current) => {
        if (live && current.signature !== preview.signature) setStale(true);
      }).catch(() => { if (live) { setStale(true); setError('Could not verify whether this preview is current. Refresh before relying on it.'); } })
        .finally(() => { checking = false; });
    };
    const timer = window.setInterval(verify, 15_000);
    window.addEventListener('focus', verify);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', verify); };
  }, [directory, preview, source, stale, visible]);
  return { preview, stale, error, refresh: capture };
}

function scopeSelectorValue(source: SelectedSource): WalkthroughScope | 'branch' | 'commit' | 'pr' {
  if (typeof source === 'string') return source;
  if (source.kind === 'working-tree') return source.scope;
  return source.kind;
}

function SourceSelector({ source, onChange }: { source: SelectedSource; onChange: (source: SelectedSource) => void }): ReactNode {
  const selected = asWalkthroughSource(source)!;
  return <select aria-label="Walkthrough scope" className="min-w-0 rounded border border-white/15 bg-neutral-950 px-1 py-1 text-[11px] text-neutral-300"
    value={scopeSelectorValue(selected)}
    onChange={(event) => {
      const value = event.currentTarget.value;
      if (value === 'all' || value === 'staged' || value === 'working') onChange(value);
      else if (value === 'branch') onChange({ kind: 'branch', baseRef: '', headRef: '' });
      else if (value === 'commit') onChange({ kind: 'commit', hash: '' });
      else onChange({ kind: 'pr', number: 0, sourceRepo: { owner: '', repo: '' } });
    }}>
    <option value="all">All uncommitted</option>
    <option value="staged">Staged</option>
    <option value="working">Unstaged</option>
    <option value="branch">Branch</option>
    <option value="commit">Commit</option>
    <option value="pr">Pull request</option>
  </select>;
}

function textInput(label: string, value: string, onChange: (value: string) => void): ReactNode {
  return <input aria-label={label} value={value} className="min-w-0 rounded border border-white/15 bg-neutral-950 px-1 py-1 text-[11px] text-neutral-300"
    onChange={(event) => onChange(event.currentTarget.value)} />;
}

function ModelSelector({ options, override }: { options: WalkthroughModelOption[]; override: string }
): ReactNode {
  const selected = options.some((option) => `${option.providerID}/${option.modelID}` === override)
    ? override : '';
  const changeModel = (model: string): void => setSettingsField('walkthroughModelOverride', model);
  return <select aria-label="Walkthrough model" className="min-w-0 max-w-64 rounded border border-white/15 bg-neutral-950 px-1 py-1 text-[11px] text-neutral-300"
    value={selected} onChange={(event) => changeModel(event.currentTarget.value)}>
    <option value="">Default chain</option>
    {options.map((option) => <option key={`${option.providerID}/${option.modelID}`}
      value={`${option.providerID}/${option.modelID}`}>{option.hasLogin ? option.label : `${option.label} (no login)`}</option>)}
    {!options.some((option) => `${option.providerID}/${option.modelID}` === override) && override
      ? <option value={override}>{override}</option> : null}
  </select>;
}

function readinessText(readiness: WalkthroughReadiness, error: boolean): string {
  if (error) return 'Model readiness is unavailable; selection may not be usable.';
  if (readiness.ready) return 'Model ready for the current diff.';
  if (readiness.reason === 'empty-diff') return 'No text hunks are available.';
  if (readiness.reason === 'only-generated') return 'Generated files are excluded from this walkthrough.';
  if (readiness.reason === 'no-model') return 'No walkthrough model is selected or available.';
  if (readiness.reason === 'no-provider-login') return 'The selected model has no provider login.';
  if (readiness.reason === 'provider-unsupported') return 'The selected provider cannot generate walkthroughs directly.';
  if (readiness.reason === 'structured-output-unsupported') return 'The selected model does not advertise JSON output.';
  if (readiness.reason === 'context-too-small') return `Diff needs ${readiness.requiredChars} chars; available is ${readiness.availableChars ?? 'unknown'}.`;
  return 'Model readiness is unavailable.';
}

function SourceFields({ source, onChange }: { source: SelectedSource; onChange: (state: SelectedSource) => void }): ReactNode | null {
  const selectedSource = typeof source === 'string' ? null : source;
  if (selectedSource?.kind === 'branch') {
    return <fieldset className="flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      {textInput('Base ref', selectedSource.baseRef, (baseRef) => onChange({ ...selectedSource, baseRef }))}
      {textInput('Head ref', selectedSource.headRef, (headRef) => onChange({ ...selectedSource, headRef }))}
    </fieldset>;
  }
  if (selectedSource?.kind === 'commit') return textInput('Commit object ID', selectedSource.hash,
    (hash) => onChange({ ...selectedSource, hash: hash.trim().toLowerCase() }));
  if (selectedSource?.kind === 'pr') {
    return <fieldset className="flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      {textInput('Pull request number', String(selectedSource.number), (value) => {
        const number = Number(value);
        onChange(Number.isSafeInteger(number) && number >= 0 ? { ...selectedSource, number } : selectedSource);
      })}
      {textInput('PR owner', selectedSource.sourceRepo?.owner ?? '', (owner) => onChange({ ...selectedSource, sourceRepo: { owner, repo: selectedSource.sourceRepo?.repo ?? '' } }))}
      {textInput('PR repository', selectedSource.sourceRepo?.repo ?? '', (repo) => onChange({ ...selectedSource, sourceRepo: { owner: selectedSource.sourceRepo?.owner ?? '', repo } }))}
    </fieldset>;
  }
  return null;
}

export function WalkthroughPreviewSurface({ directory, sessionId, visible }: { directory: string; sessionId: string | null; visible: boolean }): ReactNode {
  const [source, setSource] = useState<SelectedSource>('all');
  const [active, setActive] = useState(0);
  const override = useSettingsStore((state) => typeof state.doc.walkthroughModelOverride === 'string'
    ? state.doc.walkthroughModelOverride : '');
  const valid = validSource(source);
  const { preview, stale, error, refresh } = useWalkthroughPreview(directory, typeof source === 'string' ? source : valid, visible);
  const { record: modelRecord, error: modelError } = useWalkthroughModelReadiness(directory,
    typeof source === 'string' ? source : valid, visible, preview?.signature ?? null, override);
  const { narrative, generating, stage, error: generationError, generate, cancel, reset } = useWalkthroughNarrative(directory, typeof source === 'string' ? source : valid, sessionId, preview, stale, override);
  const stop = preview?.stops[Math.min(active, (preview?.stops.length ?? 1) - 1)];
  useEffect(() => { setActive(0); }, [identity(source), directory]);
  const changeSource = (next: SelectedSource): void => {
    if (typeof next === 'string') {
      setSource(next);
      setActive(0);
      return;
    }
    setSource(next.kind === 'working-tree' ? next.scope : next);
    setActive(0);
  };
  return <section className="flex h-full min-h-0 flex-col" data-testid="walkthrough-preview">
    <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
      <div className="w-full text-xs font-medium text-neutral-200">Diff walkthrough</div>
      <SourceSelector source={source} onChange={changeSource} />
      <ModelSelector options={modelRecord?.options ?? []} override={override} />
      <SourceFields source={source} onChange={changeSource} />
      <button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px] text-neutral-300 disabled:opacity-40"
        disabled={!validSource(source)} onClick={() => { reset(); void refresh(); }}>Refresh</button>
      <button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px] text-neutral-300 disabled:opacity-40"
        disabled={!sessionId || !preview?.stops.length || stale || generating} onClick={() => void generate()}>
        {generating ? 'Generating…' : 'Generate explanation'}
      </button>
      {generating ? <button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px] text-neutral-300" onClick={() => void cancel()}>Cancel</button> : null}
    </header>
    <div className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-400">
      Local Git hunks in patch order. Source selectors can compare branches, commits, or pull requests. Generate explicitly sends a bounded diff digest to the model shown above.
    </div>
    {modelRecord ? <div className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-400">
      {readinessText(modelRecord.readiness, modelError)}
    </div> : null}
    {!validSource(source) && typeof source !== 'string'
      ? <p className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-400">Complete all source fields to capture this walkthrough.</p> : null}
    {generating && stage ? <div className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-400">
      Walkthrough stage: {stage}
    </div> : null}
    {!sessionId ? <p className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-400">Select a session to generate an explanation.</p> : null}
    {stale && preview ? <div role="status" className="border-b border-amber-500/30 px-3 py-2 text-xs text-amber-300">
      {error ? 'The current source could not be verified against this preview. Refresh before relying on it.' : 'Changes moved since this preview was captured. Refresh to rebuild the stops.'}
    </div> : null}
    {error || generationError ? <div role="alert" className="border-b border-amber-500/30 px-3 py-2 text-xs text-amber-300">{error ?? generationError}</div> : null}
    {preview && preview.stops.length === 0 ? <p className="p-3 text-xs text-neutral-400">No text hunks to walk through. Binary-only changes are not rendered in this preview.</p> : null}
    {preview && preview.binaryFiles > 0 ? <p className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-400">{preview.binaryFiles} binary file scope(s) are omitted from hunk navigation.</p> : null}
    {narrative ? <div className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-300">
      Model explanation: {narrative.providerID}/{narrative.modelID}. Verify claims against the diff.
      {narrative.omittedSensitiveHunks > 0 ? ` ${narrative.omittedSensitiveHunks} sensitive-path hunk(s) were not sent.` : ''}
    </div> : null}
    {preview && stop ? <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
        <button type="button" aria-label="Previous hunk" disabled={active === 0} onClick={() => setActive(active - 1)}>←</button>
        <span data-testid="walkthrough-position">{active + 1} / {preview.stops.length}</span>
        <button type="button" aria-label="Next hunk" disabled={active + 1 >= preview.stops.length} onClick={() => setActive(active + 1)}>→</button>
      </div>
      <nav aria-label="Diff hunk stops" className="max-h-40 overflow-y-auto border-b border-white/10 p-2">
        {narrative?.chapters.map((chapter, index) => <div key={`${chapter.title}:${index}`} className="px-2 py-1 text-[11px] text-neutral-300">
          {chapter.title}{chapter.summary ? `: ${chapter.summary}` : ''} · {chapter.stops.length} stop(s)
        </div>)}
        {preview.stops.map((item, index) => <button key={item.id} type="button" aria-current={index === active ? 'step' : undefined}
          className={`block w-full truncate rounded px-2 py-1 text-left text-[11px] ${index === active ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'}`}
          onClick={() => setActive(index)}>{index + 1}. {sourceIdentity(source)} · {item.path}:{item.newStart}</button>)}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <div className="sticky top-0 bg-neutral-950 py-1 text-xs text-neutral-200">{sourceIdentity(source)} · {stop.path} · old:{stop.oldStart} new:{stop.newStart}</div>
        {narrative?.chapters.flatMap((chapter) => chapter.stops.map((item) => ({ ...item, chapter: chapter.title })))
          .filter((item) => item.id === stop.id).map((item) => <div key={item.id} className="mb-2 rounded border border-white/10 p-2 text-xs text-neutral-200">
            <div className="mb-1 text-[11px] text-neutral-400">{item.chapter} · {item.path} · old:{item.oldStart} new:{item.newStart} · model explanation</div>{item.explanation}
          </div>)}
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-neutral-300" data-testid="walkthrough-hunk">{stop.header}{'\n'}{stop.body}</pre>
      </div>
    </div> : null}
  </section>;
}
