// SPDX-License-Identifier: Apache-2.0
/** NNA-authored configured MCP inventory. This is not a live connection probe. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

interface McpServer {
  id: string;
  transport: 'stdio' | 'streamable_http';
  enabled: boolean;
  trusted: boolean;
}

function validServer(value: unknown): value is McpServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && ['stdio', 'streamable_http'].includes(String(item.transport))
    && typeof item.enabled === 'boolean' && typeof item.trusted === 'boolean';
}

export function McpPage(): ReactNode {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void harnessClient.getNnaMcpInventory().then((result) => {
      if (!current) return;
      const inventory = result.data;
      if (result.error || inventory?.version !== 1 || inventory.state !== 'configured'
        || !Array.isArray(inventory.servers) || !inventory.servers.every(validServer)) {
        setServers(null);
        setError(result.error ?? 'NNA returned an invalid MCP inventory.');
      } else {
        setServers(inventory.servers);
        setError(null);
      }
    }).catch(() => {
      if (current) { setServers(null); setError('NNA MCP inventory is unavailable.'); }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  return (
    <SettingsSection item="mcp.inventory">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>NNA MCP servers</SettingsGroupTitle>
        <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" onClick={refresh} disabled={loading}>Refresh</button>
      </div>
      <p className="text-xs text-muted-foreground">Configured servers in this NNA process only. Changes to NNA configuration require a restart. Connection and tool health are not tested here; destinations, commands, and credentials remain in NNA.</p>
      {loading ? <p role="status" className="text-xs text-muted-foreground">Loading MCP inventory…</p> : null}
      {!loading && error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {!loading && servers?.length === 0 ? <p className="text-xs text-muted-foreground">No MCP servers are configured in NNA.</p> : null}
      {!loading && servers?.map((server) => (
        <div key={server.id} className="rounded-md border border-border/40 p-3 text-xs" data-testid="mcp-server">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <span>{server.id}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${server.enabled ? 'bg-primary/15 text-primary' : 'bg-interactive-hover/40 text-muted-foreground'}`}>
              {server.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="mt-1 text-muted-foreground">{server.transport === 'stdio' ? 'Local process' : 'HTTP transport'} · {server.trusted ? 'Trusted' : 'Untrusted'} · Connection unverified</div>
        </div>
      ))}
    </SettingsSection>
  );
}
