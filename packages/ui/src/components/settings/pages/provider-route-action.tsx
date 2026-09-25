// SPDX-License-Identifier: Apache-2.0
/** A deliberate manifest route change. Running NNA is never silently restarted. */
import { useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';

export function ProviderRouteAction({ profileId, model, onApplied }: {
  profileId: string; model: string; onApplied: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await harnessClient.setPrimaryProviderRoute(profileId, model);
      if (result.error || !result.data?.configured_primary_route) {
        setError(result.error ?? 'NNA did not confirm the route change.');
      } else onApplied();
    } catch { setError('NNA route change is unavailable.'); }
    finally { setBusy(false); }
  };
  return <div className="mt-2">
    <button type="button" disabled={busy} onClick={() => { void apply(); }}
      className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50">
      {busy ? 'Saving route…' : 'Use this model after NNA restart'}
    </button>
    {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
  </div>;
}
