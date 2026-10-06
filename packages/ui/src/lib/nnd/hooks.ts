// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA hooks settings contract (20261006-10).
 * The nine census hooks rows (name, version, subscriptions[*].event/phase/command/
 * blocking/priority/timeout_ms/max_concurrent) observe the multi-instance hook
 * store — one manifest.json per bundle directory under the configured hooks root —
 * through the native surface /v1/nnd/configuration/hooks, which reuses the domain's
 * discoverHookBundles verbatim. The projection is read-only: runtime EXECUTION
 * stays with hook-runner, and authoring a manifest belongs to the hook-store
 * mutation story, so every field refuses editability natively
 * (hook_store_mutation_separate). Discovery's honesty channel survives the trip:
 * a malformed bundle is a skipped diagnostic, the 32-bundle cap reports the honest
 * omitted count, and an absent store is an honest 'absent' with count 0. */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/hooks';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATOR_TEXT = /^[\x20-\x7e]{1,255}$/u;
const BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const EVENTS = ['session.start', 'session.end', 'turn', 'tool.call', 'compaction',
  'context.checkpoint', 'maintenance'];
const PHASES = ['pre', 'post', 'idle'];
// NNA binds responses to its 4,194,304 ceiling plus allowance; the client keeps
// the same cap so drifted projections refuse locally too.
export const HOOKS_RESPONSE_BYTES = 4_260_096;

export class NativeHooksFailure extends Error { constructor(readonly code: string) { super(code); } }
const viewInvalid = () => new NativeHooksFailure('nnd_hooks_view_invalid');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface HookSubscription { event: string; phase: string; command: string;
  blocking: boolean; priority: number; timeout_ms: number; max_concurrent: number }
export interface HookBundle { name: string; version: string; directory_name: string;
  subscriptions: readonly HookSubscription[] }
export interface HooksList { schema_version: '1.0'; installation_id: string; data_id: string;
  scope: 'user'; source_state: 'present' | 'absent'; count: number; hooks: readonly HookBundle[];
  diagnostics: readonly HookDiagnostic[]; application: 'next_hook_use' }
export type HookDiagnostic = { bundle: string | null; status: 'skipped'; code: string }
  | { bundle: null; status: 'limit_reached'; code: 'hook_bundle_limit_reached'; omitted: number };

const LIST_KEYS = ['application', 'count', 'data_id', 'diagnostics', 'hooks',
  'installation_id', 'schema_version', 'scope', 'source_state'];
const BUNDLE_KEYS = ['directory_name', 'name', 'subscriptions', 'version'];
const SUBSCRIPTION_KEYS = ['blocking', 'command', 'event', 'max_concurrent', 'phase', 'priority',
  'timeout_ms'];

export async function readHooks(signal: AbortSignal): Promise<HooksList> {
  const response = await runtimeFetch(BASE,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  const body = await boundedJson(response, HOOKS_RESPONSE_BYTES);
  if (!response.ok) {
    const error = record(body) && record(body.error) ? body.error : null;
    const code = typeof error?.code === 'string' ? error.code
      : response.status === 404 ? 'nnd_hooks_unavailable' : 'nnd_hooks_unavailable';
    throw new NativeHooksFailure(code);
  }
  return parseHooksList(body);
}

export function parseHooksList(raw: unknown): HooksList {
  if (!record(raw)) throw viewInvalid();
  const keys = new Set(Object.keys(raw));
  if (keys.size !== LIST_KEYS.length || [...keys].some(key => !LIST_KEYS.includes(key))) throw viewInvalid();
  if (raw.schema_version !== '1.0' || raw.scope !== 'user' || raw.application !== 'next_hook_use'
    || typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id)
    || (raw.source_state !== 'present' && raw.source_state !== 'absent')
    || !Array.isArray(raw.hooks) || !Array.isArray(raw.diagnostics)) throw viewInvalid();
  if (raw.source_state === 'absent' && (raw.hooks.length !== 0 || raw.diagnostics.length !== 0)) {
    throw viewInvalid();
  }
  if (raw.hooks.length !== raw.count) throw viewInvalid();
  return { ...raw, hooks: raw.hooks.map((hook: unknown) => parseBundle(hook)) as readonly HookBundle[],
    diagnostics: raw.diagnostics.map((entry: unknown) => parseDiagnostic(entry)) } as unknown as HooksList;
}

/** The bundle projection carries exactly the census fields; the native absolute
 * directory is dropped here too (it never survived the trip in the first place). */
export function parseBundle(value: unknown): HookBundle {
  if (!record(value)) throw viewInvalid();
  const keys = new Set(Object.keys(value));
  if (keys.size !== BUNDLE_KEYS.length
    || [...keys].some(key => !BUNDLE_KEYS.includes(key))) throw viewInvalid();
  if (typeof value.name !== 'string' || !BUNDLE_NAME.test(value.name)
    || typeof value.version !== 'string' || value.version.length > 64
    || typeof value.directory_name !== 'string' || !OPERATOR_TEXT.test(value.directory_name)
    || !Array.isArray(value.subscriptions) || value.subscriptions.length > 64) throw viewInvalid();
  return { name: value.name, version: value.version, directory_name: value.directory_name,
    subscriptions: value.subscriptions.map(subscription => parseSubscription(subscription)) };
}

export function parseSubscription(value: unknown): HookSubscription {
  if (!record(value)) throw viewInvalid();
  const keys = new Set(Object.keys(value));
  if (keys.size !== SUBSCRIPTION_KEYS.length
    || [...keys].some(key => !SUBSCRIPTION_KEYS.includes(key))) throw viewInvalid();
  const { event, phase, command, blocking, priority, timeout_ms, max_concurrent } = value as Record<string, unknown>;
  if (typeof event !== 'string' || typeof phase !== 'string'
    || !EVENTS.includes(event) || !PHASES.includes(phase)) throw viewInvalid();
  if (typeof command !== 'string' || command.length < 1 || command.length > 1024
    || command.includes('\r') || command.includes('\n')) throw viewInvalid();
  if ((blocking !== true && blocking !== false) || typeof priority !== 'number'
    || !Number.isSafeInteger(priority) || priority < -100_000 || priority > 100_000
    || typeof timeout_ms !== 'number' || !Number.isSafeInteger(timeout_ms)
    || timeout_ms < 100 || timeout_ms > 300_000 || typeof max_concurrent !== 'number'
    || !Number.isSafeInteger(max_concurrent) || max_concurrent < 1 || max_concurrent > 16) {
    throw viewInvalid();
  }
  return { event, phase, command, blocking: blocking as boolean,
    priority, timeout_ms, max_concurrent } as HookSubscription;
}

export function parseDiagnostic(value: unknown): HookDiagnostic {
  if (!record(value)) throw viewInvalid();
  if (value.status === 'limit_reached') {
    const keys = new Set(Object.keys(value));
    if (keys.size !== 4 || value.bundle !== null || value.code !== 'hook_bundle_limit_reached'
      || typeof value.omitted !== 'number' || !Number.isSafeInteger(value.omitted)
      || value.omitted < 1) throw viewInvalid();
    return { bundle: null, status: 'limit_reached', code: 'hook_bundle_limit_reached',
      omitted: value.omitted } as HookDiagnostic;
  }
  if (value.status !== 'skipped') throw viewInvalid();
  const keys = new Set(Object.keys(value));
  if (keys.size !== 3 || (value.bundle !== null && (typeof value.bundle !== 'string'
    || !OPERATOR_TEXT.test(value.bundle)))
    || typeof value.code !== 'string' || !/^[a-z0-9_]{1,64}$/u.test(value.code)) throw viewInvalid();
  return { bundle: value.bundle as string | null, status: 'skipped', code: value.code } as HookDiagnostic;
}

async function boundedJson(response: Response, bounds: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw viewInvalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength; if (size > bounds) { await reader.cancel(); throw viewInvalid(); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw viewInvalid(); }
}

export function hooksErrorText(code: string): string {
  if (code === 'nnd_hooks_unavailable') return 'Hook bundle settings are unavailable.';
  if (code === 'nnd_configuration_unavailable') return 'Native hooks settings are unavailable on this NNA.';
  if (code === 'nnd_hooks_view_invalid') return 'The refused projection failed its sentence check instead.';
  return 'The hook bundle roster could not be read.';
}
