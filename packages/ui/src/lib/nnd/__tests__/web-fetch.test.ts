// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isValidWebFetchOriginDraft, nativeWebFetchOperations, nativeWebFetchRequest, parseNativeWebFetchView,
  projectNativeWebFetchOperations, NativeWebFetchFailure, type NativeWebFetchView } from '../web-fetch.ts';

const hex = (char: string) => char.repeat(64);
const presentView = (): NativeWebFetchView => ({ schema_version: '1.0', installation_id: 'install_wf',
  data_id: 'data_wf', scope: 'user', source_state: 'present', source_revision: hex('a'),
  resolution_revision: hex('a'), project_shadowed: false, version: 1, trusted_origins: Object.freeze(['https://a.example']),
  updated_at: '2026-10-06T01:02:03.000Z', application: 'next_fetch' });
const absentView = (): NativeWebFetchView => ({ ...presentView(), source_state: 'absent', source_revision: 'absent',
  resolution_revision: 'absent', trusted_origins: Object.freeze([]), updated_at: null });

describe('web fetch native view parser', () => {
  it('accepts the present projector shape and keeps the origin list sorted-unique as served', () => {
    const parsed = parseNativeWebFetchView({ ...presentView(), trusted_origins: ['https://a.example', 'https://b.example'] });
    expect(parsed.trusted_origins).toEqual(['https://a.example', 'https://b.example']);
    expect(parsed.updated_at).toBe('2026-10-06T01:02:03.000Z');
  });
  it('accepts the absent bootstrap shape with sticky defaults and the absent revision', () => {
    const parsed = parseNativeWebFetchView(absentView());
    expect(parsed.source_state).toBe('absent');
    expect(parsed.source_revision).toBe('absent');
    expect(parsed.trusted_origins).toEqual([]);
    expect(parsed.updated_at).toBeNull();
  });
  it('rejects projector drift: wrong version, loose stamps, unsorted origins, or hostile origins', () => {
    for (const raw of [
      { ...presentView(), version: 2 },
      { ...absentView(), trusted_origins: ['https://a.example'] },
      { ...presentView(), trusted_origins: ['https://b.example', 'https://a.example'] },
      { ...presentView(), trusted_origins: ['ftp://a.example'] },
      { ...presentView(), trusted_origins: ['https://user:pass@a.example'] },
      { ...presentView(), trusted_origins: ['https://a.example/gone'] },
      { ...presentView(), updated_at: 'yesterday' },
      { ...presentView(), source_revision: hex('c') },
      { ...presentView(), application: 'restart_gateway' },
    ]) expect(() => parseNativeWebFetchView(raw)).toThrow(NativeWebFetchFailure);
    const bootstrapProposal = parseNativeWebFetchView({ ...absentView(),
      trusted_origins: ['https://example.com'], updated_at: '2026-10-06T04:00:00.000Z' });
    expect(bootstrapProposal.trusted_origins).toEqual(['https://example.com']);
  });
});

describe('web fetch trust operations', () => {
  it('canonicalizes drafted origins exactly like the store will, including host case', () => {
    expect(nativeWebFetchOperations([{ op: 'trust', origin: 'https://Docs.Example.Com/' },
      { op: 'revoke', origin: 'https://a.example' }]))
      .toEqual([{ op: 'trust', origin: 'https://docs.example.com' }, { op: 'revoke', origin: 'https://a.example' }]);
  });
  it('enforces the bounded grammar and rejects hostile values before transport', () => {
    expect(() => nativeWebFetchOperations([])).toThrow(NativeWebFetchFailure);
    expect(() => nativeWebFetchOperations(Array.from({ length: 17 }, () => ({ op: 'trust', origin: 'https://a.example' }))))
      .toThrow(NativeWebFetchFailure);
    for (const bad of [{ op: 'trust', origin: 'https://a.example', extra: 1 }, { op: 'trust' },
      { op: 'trust', origin: 'https://user:pass@a.example' }, { op: 'trust', origin: 'https://a.example/gone' },
      { op: 'trust', origin: 'ftp://a.example' }, { op: 'set', origin: 'https://a.example' },
      { op: 'revoke', origin: 'not a url' },
      { op: 'trust', origin: `https://${'x'.repeat(301)}` }]) {
      expect(() => nativeWebFetchOperations([bad])).toThrow(NativeWebFetchFailure);
    }
    expect(isValidWebFetchOriginDraft('https://a.example')).toBe(true);
    expect(isValidWebFetchOriginDraft(`https://${'x'.repeat(301)}`)).toBe(false);
    expect(isValidWebFetchOriginDraft('https://user:pass@a.example')).toBe(false);
    expect(isValidWebFetchOriginDraft('not a url')).toBe(false);
  });
  it('mirrors the store normalization: trust phases dedupe and sort, revoke filters, absent greys', () => {
    const mirrored = projectNativeWebFetchOperations(absentView(), nativeWebFetchOperations([
      { op: 'trust', origin: 'https://z.example' }, { op: 'trust', origin: 'https://a.example' },
      { op: 'trust', origin: 'https://a.example' }]));
    expect(mirrored.trusted_origins).toEqual(['https://a.example', 'https://z.example']);
    const revoked = projectNativeWebFetchOperations(mirrored, nativeWebFetchOperations([{ op: 'revoke', origin: 'https://z.example' }]));
    expect(revoked.trusted_origins).toEqual(['https://a.example']);
    const noop = projectNativeWebFetchOperations(presentView(), nativeWebFetchOperations([
      { op: 'revoke', origin: 'https://absent.example' }]));
    expect(noop.trusted_origins).toEqual(['https://a.example']);
  });
  it('composes the CAS request from the current view, absent basis included', () => {
    const request = nativeWebFetchRequest(absentView(), nativeWebFetchOperations([{ op: 'trust', origin: 'https://a.example' }]));
    expect(request).toEqual({ installation_id: 'install_wf', data_id: 'data_wf', scope: 'user',
      expected_revision: 'absent', expected_resolution_revision: 'absent',
      operations: [{ op: 'trust', origin: 'https://a.example' }] });
    expect(() => nativeWebFetchRequest(presentView(), nativeWebFetchOperations([]))).toThrow(NativeWebFetchFailure);
  });
});
