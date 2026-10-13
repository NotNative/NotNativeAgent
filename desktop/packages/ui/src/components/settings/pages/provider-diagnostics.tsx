// SPDX-License-Identifier: Apache-2.0
/** Explicit provider probes; NNA keeps credentials and performs all network I/O. */
import { useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { useI18n } from '../../I18nProvider.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

type Diagnostic =
  | { kind: 'test'; status: 'ready' | 'model_unavailable'; selectedModel: string; discovered: number }
  | { kind: 'discover'; models: string[] };

type Feedback = { kind: 'key'; key: I18nKey } | { kind: 'raw'; message: string } | null;

const MAX_TEXT_LENGTH = 4096;

function validModels(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((model) => typeof model === 'string'
    && model.length > 0 && model.length <= 256 && model.trim().length > 0);
}

export function ProviderDiagnostics({ profileId }: { profileId: string }): ReactNode {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'test' | 'discover' | null>(null);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function run(kind: 'test' | 'discover'): Promise<void> {
    setBusy(kind);
    setFeedback(null);
    setDiagnostic(null);
    try {
      if (kind === 'test') {
        const result = await harnessClient.testProviderProfile(profileId);
        const value = result.data;
        if (result.error || value?.profile_id !== profileId || !['ready', 'model_unavailable'].includes(value.status)
          || typeof value.selected_model !== 'string' || !Number.isSafeInteger(value.discovered_models)
          || value.selected_model.length === 0 || value.selected_model.length > MAX_TEXT_LENGTH
          || value.selected_model.trim().length === 0
          || value.discovered_models < 0) {
          setFeedback(result.error
            ? { kind: 'raw', message: result.error }
            : { kind: 'key', key: 'settings.providers.diagnostics.invalidTest' });
        } else {
          setDiagnostic({ kind, status: value.status as 'ready' | 'model_unavailable',
            selectedModel: value.selected_model, discovered: value.discovered_models });
        }
      } else {
        const result = await harnessClient.discoverProviderModels(profileId);
        const value = result.data;
        if (result.error || value?.profile_id !== profileId || !validModels(value.models)) {
          setFeedback(result.error
            ? { kind: 'raw', message: result.error }
            : { kind: 'key', key: 'settings.providers.diagnostics.invalidCatalog' });
        } else {
          setDiagnostic({ kind, models: value.models });
        }
      }
    } catch {
      setFeedback({ kind: 'key', key: 'settings.providers.diagnostics.unavailable' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 border-t border-border/30 pt-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="provider-test" disabled={busy !== null} onClick={() => void run('test')} className="rounded border border-border/60 px-2 py-1 text-[11px] text-foreground disabled:opacity-50">{t('settings.providers.diagnostics.test')}</button>
        <button type="button" data-testid="provider-discover" disabled={busy !== null} onClick={() => void run('discover')} className="rounded border border-border/60 px-2 py-1 text-[11px] text-foreground disabled:opacity-50">{t('settings.providers.diagnostics.discover')}</button>
      </div>
      {busy ? <p role="status" className="mt-2 text-muted-foreground">{t('settings.providers.diagnostics.contacting')}</p> : null}
      {feedback ? <p role="alert" className="mt-2 text-destructive">{feedback.kind === 'raw' ? feedback.message : t(feedback.key)}</p> : null}
      {diagnostic?.kind === 'test' ? <p role="status" className="mt-2 text-muted-foreground">
        {t(diagnostic.status === 'ready' ? 'settings.providers.diagnostics.testReady' : 'settings.providers.diagnostics.testMissing', { model: diagnostic.selectedModel, count: diagnostic.discovered })}
      </p> : null}
      {diagnostic?.kind === 'discover' ? (
        <div className="mt-2 text-muted-foreground" data-testid="provider-models">
          <p>{t('settings.providers.diagnostics.found', { count: diagnostic.models.length })}</p>
          <ul className="mt-1 max-h-40 overflow-y-auto pl-4">
            {diagnostic.models.slice(0, 50).map((model, index) => <li key={`${index}:${model}`} className="list-disc break-all">{model}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
