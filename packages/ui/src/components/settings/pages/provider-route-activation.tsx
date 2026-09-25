// SPDX-License-Identifier: Apache-2.0
/** Applies saved provider routing only to NNA sessions created after this action. */
import { useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { useGlobalSyncStore } from '../../../sync/global-stores.ts';

export function ProviderRouteActivation({ onApplied }: { onApplied: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await harnessClient.activatePrimaryProviderRoute();
      const route = result.data?.runtime_route as Record<string, unknown> | undefined;
      if (result.error || typeof route?.providerID !== 'string' || !route.providerID.trim()
        || typeof route.modelID !== 'string' || !route.modelID.trim()
        || result.data?.existing_sessions_unchanged !== true) {
        setError(result.error ?? 'NNA did not confirm provider routing activation.');
      } else {
        const previous = useGlobalSyncStore.getState().config;
        const nnd = previous?.nnd && typeof previous.nnd === 'object' && !Array.isArray(previous.nnd)
          ? previous.nnd : {};
        useGlobalSyncStore.getState().set({ config: { ...(previous ?? {}),
          model: `${route.providerID}/${route.modelID}`,
          nnd: { ...nnd, engine: 'nna', modelSelection: 'configured',
            primaryModel: { providerID: route.providerID, modelID: route.modelID } },
        } });
        onApplied();
      }
    } catch { setError('NNA route activation is unavailable.'); }
    finally { setBusy(false); }
  };
  return <div className="mt-2">
    <button type="button" disabled={busy} onClick={() => { void apply(); }}
      className="rounded border border-amber-500/40 px-2 py-1 text-xs text-foreground disabled:opacity-50">
    {busy ? 'Applying routing…' : 'Apply saved provider routing to new sessions'}
    </button>
    {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
  </div>;
}
