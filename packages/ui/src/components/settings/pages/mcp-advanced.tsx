// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readMcpPresence, readMcpInner, mcpAdvancedMessages,
  type McpPresence, type McpInner, type McpPresenceRow, type McpInnerRow,
} from '../../../lib/nnd/advanced.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => mcpAdvancedMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';
const toSentence = (value: unknown) => (isNativeFailure(value)
  ? messageFor(value.code) : messageFor('nnd_configuration_unavailable'));
const countText = (value: number | null) => (value === null ? 'not set' : String(value));
const surfaceText = (surface: McpInnerRow['surface']) => surface.command !== null
  ? `command ${surface.command}${surface.args?.length ? ` and ${surface.args.length} arg(s)` : ''}`
    + `${surface.cwd ? ` in ${surface.cwd}` : ''}`
  : surface.endpoint !== null ? `endpoint ${surface.endpoint}` : 'unassigned';
const surfacePresence = (row: McpPresenceRow) => {
  const parts: string[] = [];
  if (row.has_command) parts.push('command');
  if (row.has_args) parts.push('args');
  if (row.has_cwd) parts.push('cwd');
  if (row.has_endpoint) parts.push('endpoint');
  return parts.length > 0 ? `transport surface: ${parts.join(', ')}` : 'transport surface: unset';
};

/** Native MCP advanced-fields observation: the per-server detail behind the
 * manifest_mcp census rows. Presence stays under the read right; the inner
 * references (environment names and secret:<id>#<field> pointers — never a
 * value) demand the manage right, exactly like the manifest save. */
export function McpAdvancedPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const [presence, setPresence] = useState<McpPresence | null>(null);
  const [inner, setInner] = useState<McpInner | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const ready = auth === 'ok' && authority === 'ready';
  const runRead = useCallback(async (detailed: boolean) => {
    if (pending.current || authorityState() !== 'ready'
      || useAuthSessionStore.getState().status !== 'ok') return;
    const controller = new AbortController();
    pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setBusy(true); setError(null);
    try {
      if (detailed) {
        const view = await readMcpInner(controller.signal);
        if (current()) { setInner(view); setPresence(extractPresence(view)); }
      } else {
        const view = await readMcpPresence(controller.signal);
        if (current()) { setPresence(view); setInner(null); }
      }
    } catch (failure) {
      if (current()) setError(toSentence(failure));
    } finally {
      if (current()) { pending.current = null; setBusy(false); }
    }
  }, []);
  const started = useRef(false);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null;
      setPresence(null); setInner(null); setBusy(false); setError(null); };
    reset();
    const unsubscribe = onRuntimeEndpointChanged(() => { started.current = false; reset(); });
    if (ready && !started.current) { started.current = true; void runRead(false); }
    if (!ready) started.current = false;
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [ready, runRead]);
  const disabled = !ready;
  return <SettingsSection item="native-mcp-advanced.observation">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>MCP server details</SettingsGroupTitle>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" data-testid="mcp-advanced-refresh"
          disabled={disabled || busy} onClick={() => { void runRead(false); }}>Refresh</button>
        <button type="button" className="btn-secondary" data-testid="mcp-inner-refresh"
          disabled={disabled || busy} onClick={() => { void runRead(true); }}>Load references</button>
      </div>
    </div>
    <p className="text-xs text-muted-foreground">Per-server detail for the user manifest's MCP
      entries. References are pointers the manifest itself wrote — an environment name or
      secret pointer, never a value; values stay inside the native service.</p>
    {!ready ? <p role="status">{auth !== 'ok'
      ? 'Sign in to read the MCP server details.'
      : 'Native authority is resynchronizing; reading is paused.'}</p> : null}
    {error ? <p role="alert" data-testid="mcp-advanced-error">{error}</p> : null}
    {presence ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs"
      data-testid="mcp-advanced-receipt">
      {presence.servers.map((row) => <PresenceRow key={row.id} row={row} />)}
    </dl> : <p>{busy ? 'Reading…' : 'The server details have not been read yet.'}</p>}
    {inner ? <div data-testid="mcp-inner-receipt" className="mt-2 border-t border-border/40 pt-2">
      {inner.servers.map((row) => <p key={row.id} className="text-xs">
        <strong>{row.id}</strong> · protocol {row.protocol_version} · {surfaceText(row.surface)}
        {row.credential ? ` · credential ${row.credential}` : ''}{row.credential_target
          ? ` · target ${row.credential_target}` : ''}
        {row.header_credentials.length > 0
          ? ` · headers ${row.header_credentials.map((entry) =>
              `${entry.header}=${entry.reference}`).join(', ')}` : ''}
        {row.header_env.length > 0 ? ` · env headers ${row.header_env.map((entry) =>
            `${entry.header} (${entry.name})`).join(', ')}` : ''}
        {row.tool_effects.length > 0 ? ` · effects ${row.tool_effects.map((entry) =>
            `${entry.tool}: ${entry.effect}`).join(', ')}` : ''}
      </p>)}
      <p className="text-xs text-muted-foreground">Load references again after manifest changes;
        the read is honest, not a cache.</p>
    </div> : null}
  </SettingsSection>;
}

function PresenceRow({ row }: { row: McpPresenceRow }): ReactNode {
  return <>
    <dt className="font-medium">{row.id}</dt>
    <dd className="break-words">
      {row.has_credential ? 'credential bound' : 'no credential'} ·
      {' '}headers {countText(row.header_credential_count)} ·
      {' '}effects {countText(row.tool_effect_count)} ·
      {' '}{row.has_protocol_version ? 'protocol pinned' : 'protocol default'} ·
      {' '}{surfacePresence(row)}
    </dd>
  </>;
}

function extractPresence(view: McpInner): McpPresence {
  return { schema_version: '1.0', installation_id: view.installation_id,
    data_id: view.data_id, scope: 'user', source_state: 'present',
    source_revision: view.source_revision, resolution_revision: view.resolution_revision,
    project_shadowed: view.project_shadowed, application: 'not_applied',
    servers: view.servers.map((row) => row.presence) };
}
