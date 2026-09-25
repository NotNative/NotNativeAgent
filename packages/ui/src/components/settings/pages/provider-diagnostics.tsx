// SPDX-License-Identifier: Apache-2.0
/** Explicit provider probes; NNA keeps credentials and performs all network I/O. */
import { useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';

type Diagnostic =
  | { kind: 'test'; status: 'ready' | 'model_unavailable'; selectedModel: string; discovered: number }
  | { kind: 'discover'; models: string[] };

function validModels(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((model) => typeof model === 'string' && model.length > 0 && model.length <= 256);
}

export function ProviderDiagnostics({ profileId }: { profileId: string }): ReactNode {
  const [busy, setBusy] = useState<'test' | 'discover' | null>(null);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'test' | 'discover'): Promise<void> {
    setBusy(kind);
    setError(null);
    setDiagnostic(null);
    try {
      if (kind === 'test') {
        const result = await harnessClient.testProviderProfile(profileId);
        const value = result.data;
        if (result.error || value?.profile_id !== profileId || !['ready', 'model_unavailable'].includes(value.status)
          || typeof value.selected_model !== 'string' || !Number.isSafeInteger(value.discovered_models)
          || value.discovered_models < 0) {
          setError(result.error ?? 'NNA returned an invalid provider test result.');
        } else {
          setDiagnostic({ kind, status: value.status as 'ready' | 'model_unavailable',
            selectedModel: value.selected_model, discovered: value.discovered_models });
        }
      } else {
        const result = await harnessClient.discoverProviderModels(profileId);
        const value = result.data;
        if (result.error || value?.profile_id !== profileId || !validModels(value.models)) {
          setError(result.error ?? 'NNA returned an invalid model catalog.');
        } else {
          setDiagnostic({ kind, models: value.models });
        }
      }
    } catch {
      setError('Provider diagnostics are unavailable.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 border-t border-border/30 pt-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void run('test')} className="rounded border border-border/60 px-2 py-1 text-[11px] text-foreground disabled:opacity-50">Test configured model</button>
        <button type="button" disabled={busy !== null} onClick={() => void run('discover')} className="rounded border border-border/60 px-2 py-1 text-[11px] text-foreground disabled:opacity-50">Discover models</button>
      </div>
      {busy ? <p role="status" className="mt-2 text-muted-foreground">Contacting provider via NNA…</p> : null}
      {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
      {diagnostic?.kind === 'test' ? <p role="status" className="mt-2 text-muted-foreground">{diagnostic.status === 'ready' ? 'Configured model found in provider catalog' : 'Configured model not found in provider catalog'}: {diagnostic.selectedModel} ({diagnostic.discovered} models discovered). This does not test inference.</p> : null}
      {diagnostic?.kind === 'discover' ? (
        <div className="mt-2 text-muted-foreground" data-testid="provider-models">
          <p>{diagnostic.models.length} models found. Showing up to 50.</p>
          <ul className="mt-1 max-h-40 overflow-y-auto pl-4">
            {diagnostic.models.slice(0, 50).map((model) => <li key={model} className="list-disc break-all">{model}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
