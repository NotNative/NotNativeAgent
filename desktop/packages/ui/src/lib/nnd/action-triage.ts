// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA action-triage contract (20261006-20). Wraps the two native
 * triage surfaces the -20 slice added over
 * /api/v1/nnd/configuration/gateway/status + /actions/test and
 * /api/v1/nnd/configuration/web-search/actions/managed-status, plus the
 * honest CLI-only refusal grammar (nnd_action_cli_only 200 verdicts) pinned
 * by the gateway_action/web_search_action census families.
 */
import { runtimeFetch } from '../runtime-fetch.ts';

const GATEWAY_STATUS = '/api/v1/nnd/configuration/gateway/status';
const GATEWAY_TEST = '/api/v1/nnd/configuration/gateway/actions/test';
const SEARXNG_STATUS = '/api/v1/nnd/configuration/web-search/actions/managed-status';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BOUND = 16_384;
const CONNECTIVITY = ['telegram_token_missing', 'gateway_test_unreachable'];

export interface GatewayRuntimeReceipt {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  family: 'gateway'; action: 'status'; application: 'not_applied';
  config: { enabled: boolean; configured: boolean;
    token_source: string | null; authorized_user_ids: string[];
    workspace_root: string | null; polling_timeout_seconds: number };
  runtime: { running: boolean; pid?: number; verified?: boolean; stale?: boolean; reason?: string };
}

export interface GatewayTestOkReceipt {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  family: 'gateway'; action: 'test'; application: 'not_applied';
  ok: true; bot: { id: number; username: string | null };
}

export interface TriageRefusalReceipt {
  schema_version: '1.0'; installation_id: null; data_id: null; scope: 'user';
  family: 'gateway' | 'searxng'; action: string; application: 'not_applied';
  refused: true; reason: string; hint: string;
}

export interface SearxngStatusReceipt {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  family: 'searxng'; action: 'managed-status'; application: 'not_applied';
  status: { endpoint: string; container: string;
    container_error: string | null; search: { ok: boolean; error?: string } };
}

export class NativeActionTriageFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeActionTriageFailure'; this.code = code; }
}

const viewInvalid = () => new NativeActionTriageFailure('nnd_action_triage_projection_invalid');
const GATEWAY_STATUS_KEYS = 'action,application,config,data_id,family,'
  + 'installation_id,runtime,schema_version,scope';
const GATEWAY_STATUS_CONFIG_KEYS = 'authorized_user_ids,configured,enabled,'
  + 'polling_timeout_seconds,token_source,workspace_root';
const TEST_OK_KEYS = 'action,application,bot,data_id,family,installation_id,ok,schema_version,scope';
const REFUSAL_KEYS = 'action,application,data_id,family,hint,installation_id,'
  + 'reason,refused,schema_version,scope';
const SEARXNG_KEYS = 'action,application,data_id,family,installation_id,schema_version,scope,status';
const SEARXNG_STATUS_KEYS = 'container,container_error,endpoint,search';

/** Local mirror of the route's fail-closed gateway status projector. */
export function parseNativeGatewayStatus(raw: unknown): GatewayRuntimeReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const r = raw as Record<string, unknown>;
  const config = r.config as
    { enabled?: unknown; configured?: unknown; token_source?: unknown;
      authorized_user_ids?: unknown; workspace_root?: unknown;
      polling_timeout_seconds?: unknown } | undefined;
  const runtime = r.runtime as
    { running?: unknown; pid?: unknown; verified?: unknown; stale?: unknown; reason?: unknown } | undefined;
  if (Object.keys(r).sort().join(',') !== GATEWAY_STATUS_KEYS
    || r.schema_version !== '1.0' || typeof r.installation_id !== 'string' || !ID.test(r.installation_id)
    || typeof r.data_id !== 'string' || !ID.test(r.data_id) || r.scope !== 'user'
    || r.family !== 'gateway' || r.action !== 'status' || r.application !== 'not_applied'
    || !config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).sort().join(',') !== GATEWAY_STATUS_CONFIG_KEYS
    || typeof config.enabled !== 'boolean' || typeof config.configured !== 'boolean'
    || (config.token_source !== null && typeof config.token_source !== 'string')
    || !Array.isArray(config.authorized_user_ids)
    || (config.authorized_user_ids as unknown[]).some((id) => typeof id !== 'string')
    || (config.workspace_root !== null && typeof config.workspace_root !== 'string')
    || !Number.isSafeInteger(config.polling_timeout_seconds)
    || !runtime || typeof runtime !== 'object' || Array.isArray(runtime)
    || typeof runtime.running !== 'boolean') throw viewInvalid();
  if (runtime.running === true) {
    if (!Number.isSafeInteger(runtime.pid)) throw viewInvalid();
  } else if (runtime.pid !== undefined && typeof runtime.pid !== 'number') throw viewInvalid();
  return r as unknown as GatewayRuntimeReceipt;
}

/** Local mirror of the route's fail-closed test projector (both verdicts). */
export function parseNativeGatewayTest(raw: unknown): GatewayTestOkReceipt | TriageRefusalReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(',');
  const bot = r.bot as { id?: unknown; username?: unknown } | undefined;
  if (r.refused !== true) {
    if (keys !== TEST_OK_KEYS
      || r.schema_version !== '1.0' || typeof r.installation_id !== 'string' || !ID.test(r.installation_id)
      || typeof r.data_id !== 'string' || !ID.test(r.data_id) || r.scope !== 'user'
      || r.family !== 'gateway' || r.action !== 'test' || r.application !== 'not_applied'
      || r.ok !== true
      || !bot || typeof bot !== 'object' || Array.isArray(bot)
      || Object.keys(bot).sort().join(',') !== 'id,username'
      || !Number.isSafeInteger(bot.id)
      || (bot.username !== null && typeof bot.username !== 'string')) throw viewInvalid();
    return r as unknown as GatewayTestOkReceipt;
  }
  if (keys !== REFUSAL_KEYS
    || (r.family !== 'gateway' && r.family !== 'searxng')
    || typeof r.action !== 'string' || r.action.length === 0
    || typeof r.reason !== 'string' || typeof r.hint !== 'string'
    || r.reason.length === 0 || r.hint.length === 0) throw viewInvalid();
  return { schema_version: '1.0', installation_id: null, data_id: null, scope: 'user',
    family: r.family, action: r.action, application: 'not_applied',
    refused: true, reason: r.reason, hint: r.hint };
}

/** Local mirror of the route's fail-closed managed-deployment projector. */
export function parseNativeSearxngStatus(raw: unknown): SearxngStatusReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const r = raw as Record<string, unknown>;
  const status = r.status as
    { container?: unknown; container_error?: unknown; endpoint?: unknown;
      search?:
        { ok?: unknown; error?: unknown } } | undefined;
  if (Object.keys(r).sort().join(',') !== SEARXNG_KEYS
    || r.schema_version !== '1.0' || typeof r.installation_id !== 'string' || !ID.test(r.installation_id)
    || typeof r.data_id !== 'string' || !ID.test(r.data_id) || r.scope !== 'user'
    || r.family !== 'searxng' || r.action !== 'managed-status' || r.application !== 'not_applied'
    || !status || typeof status !== 'object' || Array.isArray(status)
    || Object.keys(status).sort().join(',') !== SEARXNG_STATUS_KEYS
    || typeof status.container !== 'string'
    || (status.container_error !== null && typeof status.container_error !== 'string')
    || typeof status.endpoint !== 'string'
    || !status.search || typeof status.search !== 'object' || Array.isArray(status.search)
    || typeof status.search.ok !== 'boolean'
    || (status.search.error !== undefined && typeof status.search.error !== 'string')) throw viewInvalid();
  return r as unknown as SearxngStatusReceipt;
}

/** Honest sentence map; unmatched codes fall back to the code. */
export const actionTriageMessages: Record<string, string> = {
  nnd_action_triage_projection_invalid: 'The gateway or SearXNG view drifted from its verified grammar.',
  nnd_configuration_unavailable: 'This runtime does not serve the gateway or SearXNG action views.',
  integration_permission_denied: 'This account lacks the read right for the gateway or SearXNG action views.',
};

async function nativeRead(url: string, signal: AbortSignal,
  parse: (raw: unknown) => unknown, post = false): Promise<unknown> {
  const response = await runtimeFetch(url, {
    method: post ? 'POST' : 'GET',
    ...(post ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (response.status === 404) throw new NativeActionTriageFailure('nnd_action_triage_unavailable');
  if (response.status !== 200) {
    const raw = await response.arrayBuffer();
    let code = 'nnd_action_triage_unavailable';
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
        { error?: { code?: unknown } };
      if (parsed?.error && typeof parsed.error.code === 'string') code = parsed.error.code;
    } catch { /* keep the loopback-surface sentence */ }
    throw new NativeActionTriageFailure(code);
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > BOUND) throw viewInvalid();
  return parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
}

export async function readNativeGatewayStatus(signal: AbortSignal): Promise<GatewayRuntimeReceipt> {
  return await nativeRead(GATEWAY_STATUS, signal, parseNativeGatewayStatus) as GatewayRuntimeReceipt;
}

export async function readNativeGatewayTest(signal: AbortSignal): Promise<GatewayTestOkReceipt | TriageRefusalReceipt> {
  return await nativeRead(GATEWAY_TEST, signal, parseNativeGatewayTest, true) as GatewayTestOkReceipt | TriageRefusalReceipt;
}

export async function readNativeSearxngStatus(signal: AbortSignal): Promise<SearxngStatusReceipt> {
  return await nativeRead(SEARXNG_STATUS, signal, parseNativeSearxngStatus) as SearxngStatusReceipt;
}

/** Refusal verdict sentences: the honest CLI-authority hint, verbatim. */
export function refusalSentence(receipt: TriageRefusalReceipt): string {
  if (receipt.reason === 'telegram_token_missing') {
    return 'No Telegram token is configured; set it with the gateway command lines first.';
  }
  if (receipt.reason === 'gateway_test_unreachable') {
    return 'The Telegram API probe failed; check connectivity or the token.';
  }
  if (receipt.reason === 'nnd_action_cli_only') {
    return receipt.hint;
  }
  return receipt.reason;
}

export { CONNECTIVITY as ACTION_CONNECTIVITY_CODES };
