// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { multiRunIdentityOf, storedMultiRunIdentity } from '../identity.ts';
import { __resetSessionOrgStoreForTests, useSessionOrgStore } from '../../../stores/useSessionOrgStore.ts';

vi.mock('../../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/session-org')) throw new Error(`unexpected fetch ${url}`);
    if ((init?.method ?? 'GET') !== 'POST') return Response.json({ version: 1, exists: true, records: {} });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { sessionID: string; op: string };
    const { directory: _d, sessionID: _s, op: _o, ...extra } = body;
    return Response.json({ success: true, record: extra });
  }),
}));

beforeEach(() => { __resetSessionOrgStoreForTests(); });

describe('durable multi-run identity', () => {
  it('prefers the stored record over the legacy title parse', () => {
    useSessionOrgStore.setState({
      recordsByDirectory: { 'D:/work': { s1: { multiRun: {
        groupSlug: 'stored', providerID: 'record', modelID: 'model', index: 3 } } } },
      loadedDirectories: { 'D:/work': true },
    });
    expect(multiRunIdentityOf({
      id: 's1', directory: 'D:/work', title: 'renamed/openai/other' })).toEqual({
      groupSlug: 'stored', providerID: 'record', modelID: 'model', index: 3, fusion: false });
    expect(storedMultiRunIdentity('D:/work', 'missing')).toBeUndefined();
  });

  it('falls back to the title parse and marks fusion titles', () => {
    expect(multiRunIdentityOf({
      id: 's2', directory: 'D:/work', title: 'g2/rework/openai/gpt-5.2/2' })).toEqual({
      groupSlug: 'rework', runGroup: 'g2', providerID: 'openai', modelID: 'gpt-5.2', index: 2, fusion: false });
    expect(multiRunIdentityOf({
      id: 's3', directory: 'D:/work', title: 'rework/openai/gpt/fusion' })).toMatchObject({ fusion: true });
    expect(multiRunIdentityOf({ id: 's4', directory: 'D:/work', title: 'Ordinary chat' })).toBeUndefined();
    expect(multiRunIdentityOf({ id: 's5', directory: 'D:/work', title: 'demo/only-model' })).toBeUndefined();
  });

  it('keeps fusion record readers honest for stored entries', () => {
    useSessionOrgStore.setState({
      recordsByDirectory: { 'D:/work': { s6: { multiRun: {
        groupSlug: 'rework', providerID: 'openai', modelID: 'gpt', fusion: true } } } },
      loadedDirectories: { 'D:/work': true },
    });
    expect(multiRunIdentityOf({ id: 's6', directory: 'D:/work', title: 'renamed/openai/other' }))
      .toMatchObject({ fusion: true });
  });
});
