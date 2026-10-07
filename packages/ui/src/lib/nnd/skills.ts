// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA skills-catalog family contract (20261006-18). The census
 * skills_action row wraps the skills CLI authority (runSkillsCommand →
 * SkillRegistry over runtimeSkillRoots): this lib pins its native read —
 * GET /api/v1/nnd/configuration/skills/catalog re-initializes the same
 * registry authority against the served workspace and freezes the catalog
 * plus its diagnostics; the failure codes surface honestly (the wrapped
 * authority failure keeps nnd_skills_catalog_unavailable at 503). Entry
 * grammar mirrors the route's projection: {id, version, description,
 * invocation, source, requires_tools, body_sha256}; never a skill body.
 */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/skills';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const SOURCE = /^(bundled|user|project):/u;
const RESPONSE_BOUND = 2_097_152;

export interface NativeSkillEntry {
  id: string; version: string; description: string | null;
  invocation: 'user' | 'agent' | 'both'; source: string;
  requires_tools: string[]; body_sha256: string;
}
export interface NativeSkillDiagnostic {
  status: 'skipped'; scope: string; path: string; code: string; message: string;
}
export interface NativeSkillsCatalogReceipt {
  schema_version: '1.0'; installation_id: string; data_id: string;
  scope: 'workspace'; scope_root: string; trusted: boolean;
  catalog: NativeSkillEntry[]; diagnostics: NativeSkillDiagnostic[];
}

export class NativeSkillsFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeSkillsFailure'; this.code = code; }
}

const viewInvalid = () => new NativeSkillsFailure('nnd_skills_projection_invalid');

const ENTRY_KEYS = 'body_sha256,description,id,invocation,requires_tools,source,version';
const DIAGNOSTIC_KEYS = 'code,message,path,scope,status';
const RECEIPT_KEYS = 'catalog,data_id,diagnostics,installation_id,schema_version,scope,scope_root,trusted';

/** Local mirror of the route's fail-closed projector. */
export function parseNativeSkillsCatalog(raw: unknown): NativeSkillsCatalogReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const receipt = raw as Record<string, unknown>;
  if (Object.keys(receipt).sort().join(',') !== RECEIPT_KEYS
    || receipt.schema_version !== '1.0'
    || typeof receipt.installation_id !== 'string' || !ID.test(receipt.installation_id)
    || typeof receipt.data_id !== 'string' || !ID.test(receipt.data_id)
    || receipt.scope !== 'workspace'
    || typeof receipt.scope_root !== 'string' || (receipt.scope_root as string).length === 0
    || typeof receipt.trusted !== 'boolean'
    || !Array.isArray(receipt.catalog) || (receipt.catalog as unknown[]).length > 4096
    || !Array.isArray(receipt.diagnostics)) throw viewInvalid();
  const keys = (value: unknown) => Object.keys(value as object).sort().join(',');
  const catalog = (receipt.catalog as unknown[]).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || keys(entry) !== ENTRY_KEYS
      || typeof (entry as Record<string, unknown>).id !== 'string'
      || ((entry as Record<string, unknown>).id as string).length === 0
      || typeof (entry as Record<string, unknown>).version !== 'string'
      || ((entry as Record<string, unknown>).version as string).length === 0
      || !(((entry as Record<string, unknown>).description === null)
        || typeof (entry as Record<string, unknown>).description === 'string')
      || (typeof (entry as Record<string, unknown>).description === 'string'
        && ((entry as Record<string, unknown>).description as string).length > 2_048)
      || !['user', 'agent', 'both'].includes((entry as Record<string, unknown>).invocation as never)
      || typeof (entry as Record<string, unknown>).source !== 'string'
      || !SOURCE.test((entry as Record<string, unknown>).source as string)
      || !Array.isArray((entry as Record<string, unknown>).requires_tools)
      || ((entry as Record<string, unknown>).requires_tools as unknown[]).some(
        (tool) => typeof tool !== 'string')
      || typeof (entry as Record<string, unknown>).body_sha256 !== 'string'
      || !SHA.test((entry as Record<string, unknown>).body_sha256 as string)) throw viewInvalid();
    return entry as NativeSkillEntry;
  });
  const diagnostics = (receipt.diagnostics as unknown[]).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || keys(item) !== DIAGNOSTIC_KEYS
      || (item as Record<string, unknown>).status !== 'skipped'
      || typeof (item as Record<string, unknown>).path !== 'string'
      || typeof (item as Record<string, unknown>).scope !== 'string'
      || typeof (item as Record<string, unknown>).code !== 'string'
      || typeof (item as Record<string, unknown>).message !== 'string') throw viewInvalid();
    return item as NativeSkillDiagnostic;
  });
  return { ...(receipt as unknown as Omit<NativeSkillsCatalogReceipt, 'catalog' | 'diagnostics'>),
    catalog, diagnostics };
}

/** Read the served workspace's skills catalog through the native read. */
export async function readNativeSkillsCatalog(signal: AbortSignal): Promise<NativeSkillsCatalogReceipt> {
  const response = await runtimeFetch(`${BASE}/catalog`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
  if (response.status === 404) throw new NativeSkillsFailure('nnd_skills_not_available');
  if (response.status !== 200) {
    const raw = await response.arrayBuffer();
    let code = 'nnd_skills_unavailable';
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
        { error?: { code?: unknown } };
      if (parsed?.error && typeof parsed.error.code === 'string') code = parsed.error.code;
    } catch { /* keep the loopback-surface sentence */ }
    throw new NativeSkillsFailure(code);
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > RESPONSE_BOUND) throw viewInvalid();
  return parseNativeSkillsCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
}

/** Honest sentence map; unmatched codes fall back to the code. */
export const skillsMessages: Record<string, string> = {
  nnd_skills_unavailable: 'The skills catalog observation is unavailable on this runtime.',
  nnd_skills_not_available: 'This runtime does not serve the skills catalog observation.',
  nnd_skills_request_invalid: 'This runtime could not resolve the workspace for the skills catalog.',
  nnd_skills_catalog_unavailable: 'The skills catalog could not be loaded; check the skill folders for unreadable files.',
  nnd_skills_catalog_too_large: 'The skills catalog exceeds its response bound and was refused.',
  nnd_skills_projection_invalid: 'The skills catalog view drifted from its verified grammar.',
  integration_permission_denied: 'This account lacks the read right for the skills catalog observation.',
};
