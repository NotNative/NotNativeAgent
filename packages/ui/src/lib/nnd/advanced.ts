// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA MCP advanced-fields contract (20261006-22). Two fail-closed
 * grammars over /api/v1/nnd/configuration/mcp/advanced:
 *  - presence (default GET): per-server boolean/count rows — no sensitive
 *    inner value, no references, readable with the read right;
 *  - inner (x-nnd-inner: inner): adds credential/header REFERENCES (an
 *    environment name or secret:<id>#<field> — never a value), the header
 *    environment map, tool effect rules, the protocol version, and the
 *    transport surface (command/args/cwd or endpoint), readable only with
 *    the manage right — the write-class right the manifest save demands.
 * The references are what the operator wrote in their own manifest; the
 * secret VALUE behind them still never crosses this client.
 */
import { runtimeFetch } from '../runtime-fetch.ts';

const ADVANCED = '/api/v1/nnd/configuration/mcp/advanced';
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/u;
const SERVER = /^[A-Za-z0-9_-]{1,64}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const BOUND = 65_536;

export interface McpPresenceRow {
  id: string; has_credential: boolean; has_credential_target: boolean;
  header_credential_count: number | null; has_header_env: boolean;
  tool_effect_count: number | null; has_protocol_version: boolean;
  has_command: boolean; has_args: boolean; has_cwd: boolean; has_endpoint: boolean;
}
export type McpPresence =
  { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
    source_state: 'present'; source_revision: string; resolution_revision: string;
    project_shadowed: boolean; application: 'not_applied'; servers: McpPresenceRow[] };
export interface McpHeaderReference { header: string; reference: string; field: string | null }
export interface McpHeaderEnvironment { header: string; name: string }
export interface McpToolEffect { tool: string; effect: 'allowed' | 'denied' | 'unknown' }
export interface McpInnerRow {
  id: string; credential: string | null; credential_target: string | null;
  header_credentials: McpHeaderReference[]; header_env: McpHeaderEnvironment[];
  tool_effects: McpToolEffect[]; protocol_version: string;
  surface: { command: string | null; args: string[] | null; cwd: string | null; endpoint: string | null };
  presence: McpPresenceRow;
}
export type McpInner =
  { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
    source_revision: string; resolution_revision: string; project_shadowed: boolean;
    application: 'not_applied'; servers: McpInnerRow[] };

export class NativeMcpAdvancedFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeMcpAdvancedFailure'; this.code = code; }
}
const viewInvalid = () => new NativeMcpAdvancedFailure('nnd_mcp_advanced_projection_invalid');
const PRESENCE_KEYS = 'application,data_id,installation_id,project_shadowed,'
  + 'resolution_revision,schema_version,scope,servers,source_revision,source_state';
const PRESENCE_ROW_KEYS = 'has_args,has_command,has_credential,has_credential_target,'
  + 'has_cwd,has_endpoint,has_header_env,has_protocol_version,header_credential_count,'
  + 'id,tool_effect_count';
const INNER_KEYS = 'application,data_id,installation_id,project_shadowed,'
  + 'resolution_revision,schema_version,scope,servers,source_revision';
const INNER_ROW_KEYS = 'credential,credential_target,header_credentials,'
  + 'header_env,id,presence,protocol_version,surface,tool_effects';
const SURFACE_KEYS = 'args,command,cwd,endpoint';

function envelope(value: Record<string, unknown>, inner: boolean): void {
  if (Object.keys(value).sort().join(',') !== (inner ? INNER_KEYS : PRESENCE_KEYS)
    || value.schema_version !== '1.0' || typeof value.installation_id !== 'string'
    || !IDENTITY.test(value.installation_id) || typeof value.data_id !== 'string'
    || !IDENTITY.test(value.data_id) || value.scope !== 'user'
    || value.application !== 'not_applied'
    || typeof value.source_revision !== 'string' || !REVISION.test(value.source_revision)
    || !Array.isArray(value.servers) || typeof value.project_shadowed !== 'boolean'
    || !(value.resolution_revision === 'absent'
      || typeof value.resolution_revision === 'string' && REVISION.test(value.resolution_revision))
    || !inner && (value.source_state !== 'present')) throw viewInvalid();
}

/** Local mirror of the route's fail-closed presence projector. */
export function parseMcpPresence(raw: unknown): McpPresence {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  envelope(raw as Record<string, unknown>, false);
  for (const row of (raw as Record<string, unknown>).servers as unknown[]) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw viewInvalid();
    const r = row as Record<string, unknown>;
    if (Object.keys(r).sort().join(',') !== PRESENCE_ROW_KEYS
      || typeof r.id !== 'string' || !SERVER.test(r.id)
      || Bools.some((key) => typeof r[key] !== 'boolean')
      || Counts.some((key) => r[key] !== null
        && (typeof r[key] !== 'number' || !Number.isSafeInteger(r[key]) || (r[key] as number) < 0))) throw viewInvalid();
  }
  return raw as unknown as McpPresence;
}
const Bools = ['has_credential', 'has_credential_target', 'has_header_env',
  'has_protocol_version', 'has_command', 'has_args', 'has_cwd', 'has_endpoint'] as const;
const Counts = ['header_credential_count', 'tool_effect_count'] as const;

/** Local mirror of the route's fail-closed inner projector. */
export function parseMcpInner(raw: unknown): McpInner {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const r = raw as Record<string, unknown>;
  envelope(r, true);
  for (const row of r.servers as unknown[]) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw viewInvalid();
    const g = row as Record<string, unknown>;
    if (Object.keys(g).sort().join(',') !== INNER_ROW_KEYS
      || typeof g.id !== 'string' || !SERVER.test(g.id)
      || (g.credential !== null && typeof g.credential !== 'string')
      || (g.credential_target !== null && typeof g.credential_target !== 'string')
      || typeof g.protocol_version !== 'string'
      || !Array.isArray(g.header_credentials)
      || !g.header_credentials.every((entry) => entry && typeof entry === 'object'
        && Object.keys(entry).sort().join(',') === 'field,header,reference'
        && typeof (entry as McpHeaderReference).header === 'string'
        && typeof (entry as McpHeaderReference).reference === 'string'
        && ((entry as McpHeaderReference).field === null
          || typeof (entry as McpHeaderReference).field === 'string'))
      || !Array.isArray(g.header_env)
      || !g.header_env.every((entry) => entry && typeof entry === 'object'
        && Object.keys(entry).sort().join(',') === 'header,name')
      || !Array.isArray(g.tool_effects)
      || !g.tool_effects.every((entry) => entry && typeof entry === 'object'
        && Object.keys(entry).sort().join(',') === 'effect,tool')
      || !Array.isArray((g.tool_effects as McpToolEffect[]))
      || !(g.tool_effects as McpToolEffect[]).every((entry) =>
        ['allowed', 'denied', 'unknown'].includes(entry.effect))
      || !g.surface || typeof g.surface !== 'object' || Array.isArray(g.surface)
      || Object.keys(g.surface).sort().join(',') !== SURFACE_KEYS
      || ((g.surface as McpInnerRow['surface']).command !== null
        && typeof (g.surface as McpInnerRow['surface']).command !== 'string')
      || ((g.surface as McpInnerRow['surface']).cwd !== null
        && typeof (g.surface as McpInnerRow['surface']).cwd !== 'string')
      || ((g.surface as McpInnerRow['surface']).endpoint !== null
        && typeof (g.surface as McpInnerRow['surface']).endpoint !== 'string')
      || ((g.surface as McpInnerRow['surface']).args !== null
        && !Array.isArray((g.surface as McpInnerRow['surface']).args))
      || !g.presence || typeof g.presence !== 'object' || Array.isArray(g.presence)) throw viewInvalid();
  }
  return raw as unknown as McpInner;
}

async function advancedFetch(inner: boolean, signal: AbortSignal): Promise<unknown> {
  const response = await runtimeFetch(ADVANCED, {
    method: 'GET',
    ...(inner ? { headers: { 'x-nnd-inner': 'inner' } } : {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (response.status !== 200) {
    const raw = await response.arrayBuffer();
    let code = inner ? 'nnd_mcp_advanced_inner_denied' : 'nnd_mcp_advanced_unavailable';
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
        { error?: { code?: unknown } };
      if (parsed?.error && typeof parsed.error.code === 'string') code = parsed.error.code;
    } catch { /* keep the loopback-surface sentence */ }
    throw new NativeMcpAdvancedFailure(code);
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > BOUND) throw viewInvalid();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
}

/** Read the presence view (read right). */
export async function readMcpPresence(signal: AbortSignal): Promise<McpPresence> {
  return parseMcpPresence(await advancedFetch(false, signal));
}

/** Read the inner references view (manage right). */
export async function readMcpInner(signal: AbortSignal): Promise<McpInner> {
  return parseMcpInner(await advancedFetch(true, signal));
}

/** Honest sentence map; unmatched codes fall back to the code. */
export const mcpAdvancedMessages: Record<string, string> = {
  nnd_mcp_advanced_projection_invalid: 'The MCP server details drifted from their verified grammar.',
  nnd_mcp_advanced_unavailable: 'The MCP server details are unreachable right now.',
  nnd_mcp_advanced_inner_denied: 'This account lacks the manage right for the MCP reference details.',
  nnd_configuration_unavailable: 'This runtime does not serve the MCP server details.',
  integration_permission_denied: 'This account lacks the read right for the MCP server details.',
};
