// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { harnessClient } from '../lib/nnd/client.ts';
import { reviewModeSnapshot, type ReviewMode, type ReviewModeSnapshot } from '../lib/nnd/review-mode.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';
import { useOptionalI18n } from '../lib/i18n/context.tsx';
import { enReviewMode } from '../lib/i18n/messages/en-review-mode.ts';

export function ReviewModeControl({ sessionID, busy }: { sessionID: string; busy: boolean }): ReactNode {
  const runtime = useSyncExternalStore(onRuntimeEndpointChanged, getRuntimeKey);
  return <SessionReviewMode key={`${runtime}:${sessionID}`} sessionID={sessionID} runtime={runtime} busy={busy} />;
}

function SessionReviewMode({ sessionID, runtime, busy }: { sessionID: string; runtime: string; busy: boolean }): ReactNode {
  const api = useOptionalI18n();
  const t = (key: keyof typeof enReviewMode): string => api?.t(key) ?? enReviewMode[key];
  const control = useReviewMode(sessionID, runtime, busy);
  const { state, loading, saving, failed, load, save } = control;
  return <section className="rounded-lg border border-white/10 p-3" data-testid="review-mode-control">
    <label className="flex flex-col gap-2 text-xs text-neutral-300">{t('reviewMode.label')}
      {state ? <select aria-label={t('reviewMode.label')} value={state.mode} disabled={loading || saving || busy || failed}
        className="rounded bg-neutral-800 p-2" onChange={(event) => { void save(event.target.value as ReviewMode); }}>
        {state.availableModes.map((mode) => <option key={mode} value={mode}>{t(`reviewMode.${mode}`)}</option>)}
      </select> : <span>{t(loading ? 'reviewMode.loading' : 'reviewMode.unavailable')}</span>}
    </label>
    <p className="mt-2 text-[11px] text-neutral-500">{t(state?.effective === 'unattended' ? 'reviewMode.unattendedHint' : 'reviewMode.reviewHint')}</p>
    {saving ? <p role="status">{t('reviewMode.saving')}</p> : null}
    {failed ? <p role="alert" className="mt-2 text-xs text-red-300">{t('reviewMode.failed')}</p> : null}
    <button type="button" disabled={loading || saving} className="mt-2 text-xs text-neutral-400" onClick={() => { void load(); }}>{t('reviewMode.refresh')}</button>
  </section>;
}

function useReviewMode(sessionID: string, runtime: string, busy: boolean) {
  const [state, setState] = useState<ReviewModeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const token = useRef(0);
  const pending = useRef(false);
  const load = async (): Promise<void> => {
    if (pending.current || runtime !== getRuntimeKey()) return;
    const current = ++token.current;
    setLoading(true);
    const result = await harnessClient.getSessionReviewMode(sessionID).catch(() => ({ error: 'transport', data: undefined }));
    if (current !== token.current || runtime !== getRuntimeKey()) return;
    setState(result.error ? null : reviewModeSnapshot(result.data));
    setFailed(false);
    setLoading(false);
  };
  useEffect(() => { void load(); return () => { token.current += 1; }; }, [sessionID, runtime]);
  const save = async (mode: ReviewMode): Promise<void> => {
    if (!state || busy || loading || failed || pending.current || runtime !== getRuntimeKey() || !state.availableModes.includes(mode)) return;
    const current = ++token.current;
    pending.current = true;
    setSaving(true);
    setFailed(false);
    const result = await harnessClient.setSessionReviewMode(sessionID, mode, state.revision).catch(() => ({ error: 'transport', data: undefined }));
    if (current !== token.current || runtime !== getRuntimeKey()) return;
    const confirmed = result.error ? null : reviewModeSnapshot(result.data);
    if (confirmed?.mode === mode && confirmed.revision > state.revision) setState(confirmed);
    else setFailed(true);
    pending.current = false;
    setSaving(false);
  };
  return { state, loading, saving, failed, load, save };
}
