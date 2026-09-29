// SPDX-License-Identifier: Apache-2.0
/**
 * Settings parser factory (doc 14 §F.5 legend): typed field parsers used by
 * the registry. `parse` returns the parsed value or null when the value is
 * invalid — "invalid values drop as if absent", never replaced by defaults
 * (§K invariant 1: missing is not default).
 */
import { isHexColor } from '../theme/color.ts';

export type ParseResult<T> = T | null;

export type ParserFn<T = unknown> = (value: unknown) => ParseResult<T>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function pBool(): ParserFn<boolean> {
  return (v) => (typeof v === 'boolean' ? v : null);
}

export function pStr(opts: { trim?: boolean; min?: number; max?: number; allowEmpty?: boolean } = {}): ParserFn<string> {
  return (value) => {
    if (typeof value !== 'string') return null;
    const out = opts.trim ? value.trim() : value;
    if (opts.allowEmpty === true) return out;
    if (out.length === 0) return null;
    if (opts.min !== undefined && out.length < opts.min) return null;
    if (opts.max !== undefined && out.length > opts.max) return null;
    return out;
  };
}

export function pInt(min: number, max?: number): ParserFn<number> {
  return (v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) return null;
    if (max !== undefined && v > max) return null;
    return v;
  };
}

export function pNum(min: number, max?: number): ParserFn<number> {
  return (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) return null;
    if (max !== undefined && v > max) return null;
    return v;
  };
}

export function pOneOf<const T extends string>(values: readonly T[]): ParserFn<T> {
  return (v) => (typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null);
}

/**
 * Deduped list; caps are LIMITS (§F.5 "caps are limits") — dedupe first, then
 * reject the whole value when above the cap (matches pModelRefs semantics).
 */
export function pList<T>(item: ParserFn<T>, cap?: number): ParserFn<T[]> {
  return (v) => {
    if (!Array.isArray(v)) return null;
    const out: T[] = [];
    const seen = new Set<string>();
    for (const entry of v) {
      const parsed = item(entry);
      if (parsed === null) return null;
      const identity = JSON.stringify(parsed);
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push(parsed);
      if (cap !== undefined && out.length > cap) return null;
    }
    return out;
  };
}

export function pSet(max = 256): ParserFn<string[]> {
  return (v) => {
    if (!Array.isArray(v)) return null;
    const out: string[] = [];
    for (const entry of v) {
      if (typeof entry !== 'string') return null;
      if (entry.length > 512) return null;
      if (!out.includes(entry)) out.push(entry);
    }
    return out.length <= max ? out : null;
  };
}

/** Record of string→T entries; unknown keys are caller's responsibility. */
export function pRecord<T>(value: ParserFn<T>, opts: { keyMax?: number; maxEntries?: number } = {}): ParserFn<Record<string, T>> {
  return (v) => {
    if (!isObj(v)) return null;
    const out: Record<string, T> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(v)) {
      const parsed = value(entry);
      if (parsed === null) return null;
      if (opts.maxEntries !== undefined && count >= opts.maxEntries) return null;
      out[key] = parsed;
      count += 1;
    }
    if (opts.keyMax !== undefined) {
      for (const key of Object.keys(out)) {
        if (key.length > opts.keyMax) return null;
      }
    }
    return out;
  };
}

/** ModelRef `provider/name` pairs (doc 14 §F.5 model prefs). */
export function pModelRefs(cap: number): ParserFn<string[]> {
  return (v) => {
    if (!Array.isArray(v)) return null;
    const out: string[] = [];
    for (const entry of v) {
      if (typeof entry !== 'string') return null;
      const slash = entry.indexOf('/');
      if (slash <= 0 || slash === entry.length - 1) return null;
      if (!out.includes(entry)) out.push(entry);
    }
    return out.length <= cap ? out : null;
  };
}

export function pHex(): ParserFn<string> {
  return (v) => (isHexColor(v) ? v : null);
}

const GIT_IDENTITY_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SSH_KEY_PATH = /^(?:[A-Za-z]:\/|\/)(?:[A-Za-z0-9._ -]+\/)*[A-Za-z0-9._ -]+$/u;

/** Credential-free identity profiles: a display name and an absolute local
 * SSH key path; the server controls the generated `core.sshCommand`. */
function pGitIdentityProfile(): ParserFn<{ id: string; name: string; sshKeyPath: string }> {
  return (v) => {
    if (!isObj(v)) return null;
    const id = v.id;
    const name = v.name;
    const sshKeyPath = v.sshKeyPath;
    if (typeof id !== 'string' || id.length > 64 || !GIT_IDENTITY_ID.test(id)) return null;
    if (typeof name !== 'string' || name.length > 120 || name.trim() !== name || name === '') return null;
    if (typeof sshKeyPath !== 'string' || sshKeyPath.length > 512 || sshKeyPath.includes('\\')
      || !SSH_KEY_PATH.test(sshKeyPath)) return null;
    if (sshKeyPath.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..'
      || segment !== segment.trim())) return null;
    return { id, name, sshKeyPath };
  };
}

export function pGitIdentityProfiles(): ParserFn<Array<{ id: string; name: string; sshKeyPath: string }>> {
  return (v) => {
    if (!Array.isArray(v) || v.length > 32) return null;
    const output: Array<{ id: string; name: string; sshKeyPath: string }> = [];
    const seen = new Set<string>();
    for (const entry of v) {
      const parsed = pGitIdentityProfile()(entry);
      if (parsed === null || seen.has(parsed.id)) return null;
      seen.add(parsed.id);
      output.push(parsed);
    }
    return output;
  };
}

/** §F.5 permissionAutoAccept: `{sessions: Record<id,bool>, revision: int>=0}`. */
export function pPermissionAccept(): ParserFn<{ sessions: Record<string, boolean>; revision: number }> {
  return (v) => {
    if (!isObj(v)) return null;
    const sessions = pRecord(pBool(), { maxEntries: 256 })(v.sessions);
    const revision = pInt(0)(v.revision);
    if (sessions === null || revision === null) return null;
    return { sessions, revision };
  };
}

export interface NotificationTemplate {
  titleKey?: string;
  messageKey?: string;
}

/** §F.5 notificationTemplates: {completion,error,question,subtask}×
 * {titleKey, messageKey} — i18n-KEY references, never raw strings. */
export function pNotificationTemplates(): ParserFn<Record<string, NotificationTemplate>> {
  return (v) => {
    if (!isObj(v)) return null;
    const entry = pRecord(pStr({ max: 256 }), { maxEntries: 2 });
    const out: Record<string, NotificationTemplate> = {};
    const kinds = ['completion', 'error', 'question', 'subtask'];
    const keys = Object.keys(v);
    if (keys.length > kinds.length) return null;
    for (const [kind, template] of Object.entries(v)) {
      if (!kinds.includes(kind) || !isObj(template)) return null;
      const fields = entry(template);
      if (fields === null) return null;
      if (fields.titleKey === undefined && fields.messageKey === undefined) return null;
      out[kind] = fields as { titleKey?: string; messageKey?: string };
    }
    return out;
  };
}
