// SPDX-License-Identifier: Apache-2.0
/**
 * Session-organization client: the NND-owned record store at the app origin
 * (`/api/session-org`, NOT the harness proxy). BTW linkage/markers, message
 * pins, context pins and the knowledge signature live here because NNA's
 * session PATCH carries only title/archived-time.
 */
import { runtimeFetch } from './runtime-fetch.ts';

export interface MultiRunIdentityRecord {
  groupSlug: string;
  runGroup?: string;
  providerID: string;
  modelID: string;
  index?: number;
  fusion?: true;
}

export interface SessionOrgRecord {
  btwMarker?: { originalSessionID: string; boundaryMessageID: string; promoted: boolean };
  btwChildOf?: string;
  messagePins?: { id: string; createdAt: number; role: string }[];
  contextPins?: { notes: string[]; plans: string[] };
  knowledgeSignature?: string;
  multiRun?: MultiRunIdentityRecord;
}

export type SessionOrgWrite =
  | { ok: true; record: SessionOrgRecord }
  | { ok: false; error: string; status?: number };

export type SessionOrgLoad =
  | { ok: true; records: Record<string, SessionOrgRecord> }
  | { ok: false; error: string; status?: number };

export type SessionOrgOp = 'btw.setMarker' | 'btw.markPromoted' | 'btw.setChild'
  | 'btw.clearChild' | 'pins.setMessages' | 'pins.setContext' | 'multiRun.set';

export async function loadSessionOrg(directory: string): Promise<SessionOrgLoad> {
  let response: Response;
  try {
    response = await runtimeFetch(`/api/session-org?directory=${encodeURIComponent(directory)}`);
  } catch (error) {
    return { ok: false, error: `session-org fetch failed: ${String(error)}` };
  }
  const body = await response.json().catch(() => null) as
    { version?: number; exists?: boolean; records?: Record<string, SessionOrgRecord>; error?: string } | null;
  if (!response.ok) return { ok: false, error: body?.error ?? `session-org read failed (${response.status})`, status: response.status };
  if (body?.exists === false) return { ok: true, records: {} };
  if (body?.version !== 1 || !body.records || typeof body.records !== 'object' || Array.isArray(body.records)) {
    return { ok: false, error: 'session-org snapshot has an invalid shape' };
  }
  return { ok: true, records: body.records };
}

export async function postSessionOrgOp(directory: string, sessionID: string, op: SessionOrgOp,
  extra: Record<string, unknown> = {}): Promise<SessionOrgWrite> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/session-org', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory, sessionID, op, ...extra }) });
  } catch (error) {
    return { ok: false, error: `session-org write failed: ${String(error)}` };
  }
  const body = await response.json().catch(() => null) as
    { success?: boolean; record?: SessionOrgRecord; error?: string } | null;
  if (!response.ok || body?.success !== true || !body.record
    || typeof body.record !== 'object' || Array.isArray(body.record)) {
    return { ok: false, error: body?.error ?? `session-org write failed (${response.status})`, status: response.status };
  }
  return { ok: true, record: body.record };
}
