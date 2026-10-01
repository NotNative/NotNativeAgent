// SPDX-License-Identifier: Apache-2.0
/** NNA-owned built-in delegation catalog. This is configuration, not authority. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { SubagentRouteEditor } from './subagent-route-editor.tsx';

interface Role { id: string; kind: 'built_in_subagent' }
interface Route { providerID: string; modelID: string }

function validInventory(value: unknown): value is { version: 1; state: 'configured'; route: Route; roles: Role[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const route = data.route as Record<string, unknown> | null;
  const routeIDs = route !== null && typeof route === 'object' && !Array.isArray(route)
    ? [route.providerID, route.modelID] : [];
  return data.version === 1 && data.state === 'configured' && Array.isArray(data.roles)
    && routeIDs.every((id) => typeof id === 'string' && id.length > 0)
    && data.roles.every((role: unknown) => role && typeof role === 'object'
      && typeof (role as Role).id === 'string' && (role as Role).id.length > 0
      && (role as Role).kind === 'built_in_subagent')
    && new Set(data.roles.map((role) => (role as Role).id)).size === data.roles.length;
}

export function AgentsPage(): ReactNode {
  const { t } = useI18n();
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
        setError(result.error ?? t('settings.agents.inventory.invalid'));
      } else { setInventory(result.data); setError(null); }
      }).catch(() => { if (current) { setInventory(null);
        setError(t('settings.agents.inventory.unavailable')); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  return <SettingsSection item="agents.inventory">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>{t('settings.agents.inventory.title')}</SettingsGroupTitle>
    <button type="button" data-testid="agents-refresh" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" onClick={refresh} disabled={loading}>{t('settings.agents.inventory.refresh')}</button>
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.agents.inventory.description')}</p>
    {loading ? <p role="status" className="text-xs text-muted-foreground">{t('settings.agents.inventory.loading')}</p> : null}
    {!loading && error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {!loading && inventory ? <SubagentRouteEditor runningRoute={inventory.route} onApplied={refresh} /> : null}
    {!loading && inventory?.roles.length === 0 ? <p className="text-xs text-muted-foreground">{t('settings.agents.inventory.empty')}</p> : null}
    {!loading && inventory?.roles.map((role) => <div key={role.id} data-testid="nna-agent-role"
      className="rounded-md border border-border/40 p-3 text-xs text-foreground">{role.id}</div>)}
  </SettingsSection>;
}
