// SPDX-License-Identifier: Apache-2.0
/**
 * F4.7 session-organization records: cold exists:false, bounded BTW ops,
 * message/context pin bounds, malformed-store 500 strings, oversize 413,
 * per-directory scoping. Isolated-data-dir pattern like p4-3-routes.test.ts.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-data-org-`);
const origin = 'http://test.local';
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;

type App = { fetch: (request: Request) => Promise<Response> };
let appInstance: App | null = null;
const DIRECTORY = 'C:\\proj\\demo';
const OTHER = 'C:\\proj\\other';
const ENCODED = encodeURIComponent(DIRECTORY);

async function call(path: string, init?: RequestInit): Promise<Response> {
  return appInstance!.fetch(new Request(`${origin}${path}`, init));
}

const post = (body: unknown) => call('/api/session-org', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface OrgRecord {
  btwMarker?: { originalSessionID: string; boundaryMessageID: string; promoted: boolean };
  btwChildOf?: string;
  messagePins?: { id: string; createdAt: number; role: string }[];
  contextPins?: { notes: string[]; plans: string[] };
  knowledgeSignature?: string;
}

async function recordOf(session: string): Promise<OrgRecord> {
  const response = await call(`/api/session-org?directory=${ENCODED}&sessionID=${encodeURIComponent(session)}`);
  const body = (await response.json()) as { record?: OrgRecord };
  return body.record ?? {};
}

beforeAll(async () => {
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  appInstance = { fetch: (request: Request) => Promise.resolve(createApp().fetch(request)) };
});

afterAll(() => { rmSync(isolatedDataDir, { recursive: true, force: true }); });

describe('session-organization records (F4.7)', () => {
  it('answers exists:false cold, then stores a BTW marker with validation', async () => {
    expect(await (await call(`/api/session-org?directory=${ENCODED}`)).json()).toEqual({ version: 1, exists: false });
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_child', op: 'btw.setMarker',
      marker: { originalSessionID: 'bad id!' } })).status).toBe(400);
    const ok = await post({ directory: DIRECTORY, sessionID: 'ses_child', op: 'btw.setMarker',
      marker: { originalSessionID: 'ses_parent', boundaryMessageID: 'msg_1', promoted: false } });
    expect(ok.status).toBe(200);
    expect(await recordOf('ses_child')).toMatchObject({
      btwMarker: { originalSessionID: 'ses_parent', boundaryMessageID: 'msg_1', promoted: false } });
  });

  it('guards the child link and the promotion op', async () => {
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'btw.setChild',
      childSessionID: 'nope nope' })).status).toBe(400);
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'btw.setChild',
      childSessionID: 'ses_child' })).status).toBe(200);
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'btw.markPromoted' })).status).toBe(400);
    await post({ directory: DIRECTORY, sessionID: 'ses_child', op: 'btw.markPromoted' });
    expect((await recordOf('ses_child')).btwMarker?.promoted).toBe(true);
    // clearChild with a different child is a no-op success; the exact child clears.
    await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'btw.clearChild', childSessionID: 'ses_other' });
    expect((await recordOf('ses_parent')).btwChildOf).toBe('ses_child');
    await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'btw.clearChild', childSessionID: 'ses_child' });
    expect((await recordOf('ses_parent')).btwChildOf).toBeUndefined();
  });

  it('bounds message pins at the newest 64 and clears on empty', async () => {
    const pins = Array.from({ length: 80 }, (_, index) => ({ id: `msg_${index}`, createdAt: index, role: 'user' }));
    pins.push({ id: 'msg_0', createdAt: 999, role: 'assistant' }); // dedupe keeps the last entry
    const ok = await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'pins.setMessages', pins });
    expect(ok.status).toBe(200);
    const stored = (await recordOf('ses_parent')).messagePins ?? [];
    expect(stored).toHaveLength(64);
    expect(stored.find((pin) => pin.id === 'msg_0')?.createdAt).toBe(999); // newest survives
    expect(stored.some((pin) => pin.id === 'msg_1')).toBe(false); // oldest dropped
    await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'pins.setMessages', pins: [] });
    // Empty pins are a tombstone: the key stays so legacy metadata fallbacks
    // stay dormant (an unpin-to-empty must not resurrect stale legacy pins).
    expect((await recordOf('ses_parent')).messagePins).toEqual([]);
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'pins.setMessages', pins: 'nope' })).status).toBe(400);
  });

  it('keeps empty and failed writes out of the store and accepts an empty boundary', async () => {
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_fresh', op: 'btw.clearChild',
      childSessionID: 'ses_other' })).status).toBe(200);
    expect(await recordOf('ses_fresh')).toEqual({}); // no-op writes leave no record behind
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_fresh2', op: 'no.such.op' })).status).toBe(400);
    const singleMiss = await call(`/api/session-org?directory=${ENCODED}&sessionID=ses_missing`);
    expect(await singleMiss.json()).toEqual({ version: 1, exists: false });
    await post({ directory: DIRECTORY, sessionID: 'ses_child2', op: 'btw.setMarker',
      marker: { originalSessionID: 'ses_parent', boundaryMessageID: '' } });
    expect(await recordOf('ses_child2')).toMatchObject({
      btwMarker: { originalSessionID: 'ses_parent', boundaryMessageID: '', promoted: false } });
    // A re-marked boundary keeps an earlier promotion...
    await post({ directory: DIRECTORY, sessionID: 'ses_child2', op: 'btw.markPromoted' });
    await post({ directory: DIRECTORY, sessionID: 'ses_child2', op: 'btw.setMarker',
      marker: { originalSessionID: 'ses_parent', boundaryMessageID: 'msg_2' } });
    expect((await recordOf('ses_child2')).btwMarker).toMatchObject({ boundaryMessageID: 'msg_2', promoted: true });
    // ...unless the caller overrides the flag explicitly (panel rollback).
    await post({ directory: DIRECTORY, sessionID: 'ses_child2', op: 'btw.setMarker',
      marker: { originalSessionID: 'ses_parent', boundaryMessageID: 'msg_2' }, promoted: false });
    expect((await recordOf('ses_child2')).btwMarker).toMatchObject({ promoted: false });
    const leftovers = readdirSync(isolatedDataDir).filter((name) => name.startsWith('session-org.json.tmp-'));
    expect(leftovers).toEqual([]);
    // A successful write after recovery proves the store is writable again.
    writeFileSync(joinPath(isolatedDataDir, 'session-org.json'), JSON.stringify({ version: 1, records: {}, updatedAt: 1 }));
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'btw.setChild',
      childSessionID: 'ses_child' })).status).toBe(200);
    expect((await recordOf('ses_parent')).btwChildOf).toBe('ses_child');
  });

  it('round-trips context pins with the knowledge signature', async () => {
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'pins.setContext',
      notes: ['note-1'], plans: [], knowledgeSignature: 'zz' })).status).toBe(400);
    const signature = 'a'.repeat(64);
    const ok = await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'pins.setContext',
      notes: ['note-1', 'note-2'], plans: ['plan-9'], knowledgeSignature: signature });
    expect(await recordOf('ses_parent')).toMatchObject({
      contextPins: { notes: ['note-1', 'note-2'], plans: ['plan-9'] }, knowledgeSignature: signature });
    await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'pins.setContext', notes: [], plans: [], knowledgeSignature: '' });
    expect((await recordOf('ses_parent')).contextPins).toEqual({ notes: [], plans: [] });
    expect((await recordOf('ses_parent')).knowledgeSignature).toBe('');
  });

  it('scopes records per directory and rejects bad scopes', async () => {
    await post({ directory: DIRECTORY, sessionID: 'ses_child', op: 'btw.setMarker',
      marker: { originalSessionID: 'ses_parent' } });
    await post({ directory: OTHER, sessionID: 'ses_child', op: 'btw.setMarker', marker: { originalSessionID: 'ses_parent' } });
    const all = (await (await call(`/api/session-org?directory=${ENCODED}`)).json()) as { records: Record<string, unknown> };
    expect(Object.keys(all.records)).toContain('ses_child');
    expect((await call('/api/session-org')).status).toBe(400);
    expect((await call(`/api/session-org?directory=${ENCODED}&sessionID=bad%20id`)).status).toBe(400);
  });

  it('fails closed on a malformed stored document and caps oversized bodies', async () => {
    const file = joinPath(isolatedDataDir, 'session-org.json');
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, '{"version":1,"records":7,"updatedAt":1}');
    const read = await call(`/api/session-org?directory=${ENCODED}`);
    expect(read.status).toBe(500);
    expect(((await read.json()) as { error: string }).error).toBe('Stored session-organization records are malformed');
    const write = await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'btw.setChild', childSessionID: 'ses_child' });
    expect(write.status).toBe(500);
    expect(((await write.json()) as { error: string }).error).toBe('Stored session-organization records are malformed');
    writeFileSync(file, JSON.stringify({ version: 1, records: {}, updatedAt: 1 }));
    const oversize = `{"directory":"${DIRECTORY}","sessionID":"ses_parent","op":"pins.setMessages","pins":"${'x'.repeat(5 * 1024 * 1024)}"}`;
    expect((await call('/api/session-org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversize })).status).toBe(413);
    expect((await post({ directory: DIRECTORY, sessionID: 'ses_parent', op: 'no.such.op' })).status).toBe(400);
  });
});
