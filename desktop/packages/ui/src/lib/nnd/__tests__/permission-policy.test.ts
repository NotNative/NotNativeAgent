// SPDX-License-Identifier: Apache-2.0
/** W-32.no-auto-accept: remembered approvals are refused at the boundary. */
import { describe, expect, it, vi } from 'vitest';
import { assertPermissionReply } from '../permission-policy.ts';
import { engineIdentityOf, isLegacyEngine, isNnaEngine } from '../engine-identity.ts';
import { harnessClient } from '../client.ts';

describe('engine identity (single typed owner)', () => {
  const config = (nnd: unknown) => ({ nnd }) as never;
  it('isNnaEngine is true only for the NNA engine and fails closed otherwise', () => {
    expect(isNnaEngine(config({ engine: 'nna' }))).toBe(true);
    expect(isNnaEngine(config({ engine: 'mock' }))).toBe(false);
    expect(isNnaEngine(config({ engine: 'legacy' }))).toBe(false);
    expect(isNnaEngine(config({ engine: 'future-engine' }))).toBe(false);
    expect(isNnaEngine(config({}))).toBe(false);
    expect(isNnaEngine(config(null))).toBe(false);
    expect(isNnaEngine(config('nna'))).toBe(false);
    expect(isNnaEngine(null)).toBe(false);
    expect(isNnaEngine(undefined)).toBe(false);
  });
  it('isLegacyEngine is true only for the explicit legacy value; real wire values never carry it', () => {
    expect(isLegacyEngine(config({ engine: 'legacy' }))).toBe(true);
    expect(isLegacyEngine(config({ engine: 'nna' }))).toBe(false);
    expect(isLegacyEngine(config({ engine: 'unknown-engine' }))).toBe(false);
    expect(isLegacyEngine(null)).toBe(false);
  });
  it('engineIdentityOf reports known identities and null for anything unrecognized', () => {
    expect(engineIdentityOf(config({ engine: 'nna' }))).toBe('nna');
    expect(engineIdentityOf(config({ engine: 'mock' }))).toBe('mock');
    expect(engineIdentityOf(config({ engine: 7 }))).toBeNull();
    expect(engineIdentityOf(undefined)).toBeNull();
  });
});

const runtimeFetch = vi.hoisted(() => ({ impl: null as null | ((url: string) => Promise<Response>), urls: [] as string[] }));
vi.mock('../../runtime-fetch.ts', () => ({
  runtimeFetch: async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    runtimeFetch.urls.push(url);
    return runtimeFetch.impl!(url);
  },
}));

describe('permission auto-accept prohibition (W-32.no-auto-accept)', () => {
  it('assertPermissionReply refuses "always" and admits explicit once/reject', () => {
    expect(() => assertPermissionReply('always')).toThrow('Remembered permission choices are not supported');
    expect(() => assertPermissionReply('once')).not.toThrow();
    expect(() => assertPermissionReply('reject')).not.toThrow();
  });

  it('the transport boundary refuses reply=always without issuing any request', async () => {
    runtimeFetch.urls.length = 0;
    runtimeFetch.impl = async () => new Response('{}', { status: 200 });
    await expect(harnessClient.replyToPermission('pr1', 'always')).rejects.toThrow('Remembered permission choices are not supported');
    expect(runtimeFetch.urls).toEqual([]);
    runtimeFetch.impl = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await expect(harnessClient.replyToPermission('pr1', 'once')).resolves.toMatchObject({ data: { ok: true } });
    expect(runtimeFetch.urls.join(' ')).toContain('/permission/pr1/reply');
  });
});
