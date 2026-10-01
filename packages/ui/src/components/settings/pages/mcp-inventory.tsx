// SPDX-License-Identifier: Apache-2.0
/** Read-only NNA inventory: surfaces runtime-visible servers without commands or endpoints. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsGroupTitle } from '../primitives.tsx';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

interface McpServer {
  id: string;
  transport: 'stdio' | 'streamable_http';
  enabled: boolean;
  trusted: boolean;
}

type InventoryError = { kind: 'localized'; key: I18nKey } | { kind: 'raw'; message: string };

function validServer(value: unknown): value is McpServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && ['stdio', 'streamable_http'].includes(String(item.transport))
    && typeof item.enabled === 'boolean' && typeof item.trusted === 'boolean';
}

export function NnaMcpInventory(): ReactNode {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<InventoryError | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestEpoch = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    let current = true;
    setLoading(true);
    void harnessClient.getNnaMcpInventory().then((result) => {
      if (!current || epoch !== requestEpoch.current) return;
      const inventory = result.data;
      if (result.error || inventory?.version !== 1 || inventory.state !== 'configured'
        || !Array.isArray(inventory.servers) || !inventory.servers.every(validServer)) {
        setServers(null);
        setError(result.error
          ? { kind: 'raw', message: result.error }
          : { kind: 'localized', key: 'settings.mcp.inventory.invalid' });
      } else {
        setServers(inventory.servers);
        setError(null);
      }
    }).catch(() => {
      if (current && epoch === requestEpoch.current) {
        setServers(null);
        setError({ kind: 'localized', key: 'settings.mcp.inventory.unavailable' });
      }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  useEffect(() => {
    const off = onRuntimeEndpointChanged(() => {
      requestEpoch.current += 1;
      setServers(null);
      setError(null);
      setRevision((value) => value + 1);
    });
    return () => { off(); requestEpoch.current += 1; };
  }, []);

  return (
    <section className="rounded-lg border border-border/35 p-3">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>{t('settings.mcp.inventory.title')}</SettingsGroupTitle>
        <button data-testid="mcp-inventory-refresh" type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" onClick={refresh} disabled={loading}>{t('settings.mcp.inventory.refresh')}</button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.mcp.inventory.description')}</p>
      {loading ? <p role="status" className="text-xs text-muted-foreground">{t('settings.mcp.inventory.loading')}</p> : null}
      {!loading && error && error.kind === 'raw' ? (
        <p role="alert" className="text-xs text-destructive">{t('settings.mcp.inventory.rawErrorAction')} <code>{error.message}</code></p>
      ) : !loading && error ? (
        <p role="alert" className="text-xs text-destructive">{t(error.kind === 'raw' ? 'settings.mcp.inventory.rawErrorAction' : error.key)}</p>
      ) : null}
      {!loading && servers?.length === 0 ? <p className="text-xs text-muted-foreground">{t('settings.mcp.inventory.empty')}</p> : null}
      {!loading && servers?.map((server) => (
        <div key={server.id} className="rounded-md border border-border/40 p-3 text-xs" data-testid="mcp-server">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <span>{server.id}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${server.enabled ? 'bg-primary/15 text-primary' : 'bg-interactive-hover/40 text-muted-foreground'}`}>
              {server.enabled ? t('settings.mcp.inventory.enabled') : t('settings.mcp.inventory.disabled')}
            </span>
          </div>
          <div className="mt-1 text-muted-foreground">{server.transport === 'stdio' ? t('settings.mcp.inventory.localProcess') : t('settings.mcp.inventory.httpTransport')} · {server.trusted ? t('settings.mcp.inventory.trusted') : t('settings.mcp.inventory.untrusted')} · {t('settings.mcp.inventory.unverified')}</div>
        </div>
      ))}
    </section>
  );
}
