// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA invocation-vocabulary contract (20261006-21). Wraps the native
 * read at /api/v1/nnd/configuration/invocation that projects the CLI flag
 * vocabulary behind the 23 invocation:* census rows: one entry per operator
 * row (flag, aliases, argument grammar, allowed modes, host/headless
 * refusal, parsed option key, operator-facing effect). The flags stay
 * CLI-owned; this surface DESCRIBES them honestly, so the panel only ever
 * renders a read-only vocabulary observation and never invents behavior.
 */
import { runtimeFetch } from '../runtime-fetch.ts';

const INVOCATION = '/api/v1/nnd/configuration/invocation';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BOUND = 16_384;
const ARGUMENTS = ['none', 'prompt-text', 'value'];
const REJECT_FLAGS = ['--model', '--provider-credential-env', '--provider-endpoint'];

export interface InvocationFlag {
  flag: string; aliases: string[]; argument: 'value' | 'none' | 'prompt-text';
  modes: string[] | '*'; headless: boolean; option: string | null; effect: string;
}

export interface InvocationReceipt {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  family: 'invocation'; application: 'not_applied';
  modes: string[]; flags: InvocationFlag[];
}

export class NativeInvocationFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeInvocationFailure'; this.code = code; }
}

const viewInvalid = () => new NativeInvocationFailure('nnd_invocation_projection_invalid');
const TOP_KEYS = 'application,data_id,family,flags,'
  + 'installation_id,modes,schema_version,scope';
const FLAG_KEYS = 'aliases,argument,effect,flag,headless,modes,option';

/** Local mirror of the route's fail-closed vocabulary projector. */
export function parseNativeInvocation(raw: unknown): InvocationReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== TOP_KEYS
    || r.schema_version !== '1.0' || typeof r.installation_id !== 'string' || !ID.test(r.installation_id)
    || typeof r.data_id !== 'string' || !ID.test(r.data_id) || r.scope !== 'user'
    || r.family !== 'invocation' || r.application !== 'not_applied'
    || !Array.isArray(r.modes) || r.modes.length < 1
    || (r.modes as unknown[]).some((mode) => typeof mode !== 'string')
    || !Array.isArray(r.flags) || r.flags.length !== 23) throw viewInvalid();
  const flags = (r.flags as unknown[]).map(parseFlag);
  return { schema_version: '1.0', installation_id: r.installation_id, data_id: r.data_id,
    scope: 'user', family: 'invocation', application: 'not_applied',
    modes: r.modes as string[], flags };
}

function parseFlag(raw: unknown): InvocationFlag {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const flag = raw as Record<string, unknown>;
  const modes = flag.modes;
  if (Object.keys(flag).sort().join(',') !== FLAG_KEYS
    || typeof flag.flag !== 'string' || flag.flag.length === 0
    || !Array.isArray(flag.aliases)
    || (flag.aliases as unknown[]).some((alias) => typeof alias !== 'string')
    || !ARGUMENTS.includes(flag.argument as string)
    || (modes !== '*' && (!Array.isArray(modes) || (modes as unknown[]).length === 0
      || (modes as unknown[]).some((mode) => typeof mode !== 'string')))
    || typeof flag.headless !== 'boolean'
    || (flag.option !== null && (typeof flag.option !== 'string' || flag.option.length === 0))
    || typeof flag.effect !== 'string' || flag.effect.length === 0
    || (REJECT_FLAGS.includes(flag.flag) && modes === '*' && flag.headless !== false)) {
    throw viewInvalid();
  }
  return { flag: flag.flag, aliases: flag.aliases as string[],
    argument: flag.argument as InvocationFlag['argument'],
    modes: modes === '*' ? '*' : (modes as string[]),
    headless: flag.headless, option: flag.option as string | null, effect: flag.effect };
}

/** Honest sentence map; unmatched codes fall back to the code. */
export const invocationMessages: Record<string, string> = {
  nnd_invocation_projection_invalid: 'The invocation vocabulary drifted from its verified grammar.',
  nnd_invocation_unavailable: 'The invocation vocabulary is unreachable right now.',
  nnd_configuration_unavailable: 'This runtime does not serve the invocation vocabulary.',
  integration_permission_denied: 'This account lacks the read right for the invocation vocabulary.',
};

async function nativeRead(signal: AbortSignal): Promise<unknown> {
  const response = await runtimeFetch(INVOCATION, {
    method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (response.status !== 200) {
    const raw = await response.arrayBuffer();
    let code = 'nnd_invocation_unavailable';
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
        { error?: { code?: unknown } };
      if (parsed?.error && typeof parsed.error.code === 'string') code = parsed.error.code;
    } catch { /* keep the loopback-surface sentence */ }
    throw new NativeInvocationFailure(code);
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > BOUND) throw viewInvalid();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
}

/** Read the live vocabulary observation. */
export async function readNativeInvocation(signal: AbortSignal): Promise<InvocationReceipt> {
  return parseNativeInvocation(await nativeRead(signal)) as InvocationReceipt;
}
