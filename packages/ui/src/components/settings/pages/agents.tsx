// SPDX-License-Identifier: Apache-2.0
/** NNA-owned built-in delegation catalog. This is configuration, not authority. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { SubagentRouteEditor } from './subagent-route-editor.tsx';

interface Role { id: string; kind: 'built_in_subagent' }
interface Route { providerID: string; modelID: string }

function validInventory(value: unknown): value is { version: 1; state: 'configured'; route: Route; roles: Role[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const route = data.route as Record<string, unknown> | null;
  return data.version === 1 && data.state === 'configured' && Array.isArray(data.roles)
    && data.roles.every((role: unknown) => role && typeof role === 'object'
      && typeof (role as Role).id === 'string' && (role as Role).kind === 'built_in_subagent')
    && route !== null && typeof route === 'object' && !Array.isArray(route)
    && typeof route.providerID === 'string' && typeof route.modelID === 'string';
}

export function AgentsPage(): ReactNode {
  const [inventory, setInventory] = useState<{ route: Route; roles: Role[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void harnessClient.getNnaAgentInventory().then((result) => {
      if (!current) return;
      if (result.error || !validInventory(result.data)) {
        setInventory(null);
        setError(result.error ?? 'NNA returned an invalid agent inventory.');
      } else { setInventory(result.data); setError(null); }
    }).catch(() => { if (current) { setInventory(null); setError('NNA agent inventory is unavailable.'); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  return <SettingsSection item="agents.inventory">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>NNA agents</SettingsGroupTitle>
      <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" onClick={refresh} disabled={loading}>Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">Built-in roles supported by this running NNA process. A role appearing here does not grant delegation in a particular session; NNA applies session and governance checks when invoked.</p>
    {loading ? <p role="status" className="text-xs text-muted-foreground">Loading agent catalog…</p> : null}
    {!loading && error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {!loading && inventory ? <SubagentRouteEditor runningRoute={inventory.route} onApplied={refresh} /> : null}
    {!loading && inventory?.roles.length === 0 ? <p className="text-xs text-muted-foreground">NNA reports no built-in subagent roles.</p> : null}
    {!loading && inventory?.roles.map((role) => <div key={role.id} data-testid="nna-agent-role"
      className="rounded-md border border-border/40 p-3 text-xs text-foreground">{role.id}</div>)}
  </SettingsSection>;
}
