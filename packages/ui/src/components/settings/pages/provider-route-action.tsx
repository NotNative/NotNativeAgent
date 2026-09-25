// SPDX-License-Identifier: Apache-2.0
/** A deliberate manifest route change. Running NNA is never silently updated. */
import { useEffect, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';

export function ProviderRouteAction({ profileId, defaultModel, configuredModel, onApplied }: {
  profileId: string; defaultModel: string; configuredModel: string | null; onApplied: () => void;
}): ReactNode {
  const [model, setModel] = useState(configuredModel ?? defaultModel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setModel(configuredModel ?? defaultModel); setError(null); }, [configuredModel, defaultModel]);
  const target = model.trim();
  const apply = async (): Promise<void> => {
    if (!target || target === configuredModel) return;
    setBusy(true);
    setError(null);
    try {
      const result = await harnessClient.setPrimaryProviderRoute(profileId, target);
      if (result.error || !result.data?.configured_primary_route) {
        setError(result.error ?? 'NNA did not confirm the route change.');
      } else onApplied();
    } catch { setError('NNA route change is unavailable.'); }
    finally { setBusy(false); }
  };
  return <div className="mt-2 flex flex-wrap items-end gap-2">
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">Primary model for this profile
      <input value={model} disabled={busy} maxLength={4096} onChange={(event) => setModel(event.target.value)}
        className="w-48 rounded border border-border/60 bg-background px-2 py-1 text-foreground disabled:opacity-50" />
    </label>
    <button type="button" disabled={busy || !target || target === configuredModel} onClick={() => { void apply(); }}
      className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50">
      {busy ? 'Saving route…' : 'Save primary route'}
    </button>
    {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
  </div>;
}
