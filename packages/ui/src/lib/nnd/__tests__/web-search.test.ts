// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { canonicalWebSearchEndpoint, isValidWebSearchEndpointDraft, isValidWebSearchNameDraft,
  nativeWebSearchOperations, nativeWebSearchRequest, parseNativeWebSearchView, projectNativeWebSearchOperations,
  NativeWebSearchFailure, type NativeWebSearchView } from '../web-search.ts';

const hex = (char: string) => char.repeat(64);
const profile = (id: string, endpoint = 'https://a.example'): NativeWebSearchView['profiles'][number] =>
  ({ id, display_name: `${id} search`, provider: 'searxng', endpoint, managed: false });
const presentView = (): NativeWebSearchView => ({ schema_version: '1.0', installation_id: 'install_ws',
  data_id: 'data_ws', scope: 'user', source_state: 'present', source_revision: hex('b'),
  resolution_revision: hex('b'), project_shadowed: false, version: 2, enabled: true,
  profiles: Object.freeze([profile('docs'), profile('work', 'https://work.example')]), application: 'next_search' });
const absentView = (): NativeWebSearchView => ({ ...presentView(), source_state: 'absent', source_revision: 'absent',
  resolution_revision: 'absent', enabled: false, profiles: Object.freeze([]) });

describe('web search native view parser', () => {
  it('accepts the present projector shape and preserves the served profile order', () => {
    const parsed = parseNativeWebSearchView(presentView());
    expect(parsed.profiles.map(profile => profile.id)).toEqual(['docs', 'work']);
    expect(parsed.enabled).toBe(true);
    expect(parsed.application).toBe('next_search');
  });
  it('accepts the absent bootstrap shape with sticky defaults and the absent revision', () => {
    const parsed = parseNativeWebSearchView(absentView());
    expect(parsed.source_state).toBe('absent');
    expect(parsed.source_revision).toBe('absent');
    expect(parsed.enabled).toBe(false);
    expect(parsed.profiles).toEqual([]);
  });
  it('rejects projector drift and an absent revision crashing out of the absent base', () => {
    for (const raw of [
      { ...presentView(), version: 1 },
      { ...presentView(), application: 'restart_gateway' },
      { ...presentView(), source_revision: hex('d') },
      { ...presentView(), profiles: [{ id: 'docs', display_name: 'docs', provider: 'searxng',
        endpoint: 'https://user:pass@a.example', managed: false }] },
      { ...presentView(), profiles: [profile('UPPER')] },
      { ...presentView(), profiles: [...presentView().profiles, profile('docs')] },
      { ...presentView(), enabled: 'yes' },
      { ...absentView(), source_revision: hex('e') },
    ]) expect(() => parseNativeWebSearchView(raw)).toThrow(NativeWebSearchFailure);
    // The bootstrap preview carries the richer absent shape with the absent revision.
    const bootstrapProposal = parseNativeWebSearchView({ ...absentView(), enabled: true,
      profiles: [profile('docs')] });
    expect(bootstrapProposal.enabled).toBe(true);
    expect(bootstrapProposal.profiles.map(item => item.id)).toEqual(['docs']);
  });
  it('enforces the managed flag as a boolean in both directions', () => {
    // The census row for profiles[*].managed could only cite the parser source, because
    // every fixture in this file served managed: false. The flag is a real member of the
    // profile key set, so it is asserted rather than read: a non-boolean is refused, and a
    // managed profile stays managed through the rebuild.
    const withManaged = (managed: unknown) => {
      parseNativeWebSearchView({ ...presentView(), profiles: [{ id: 'docs',
        display_name: 'docs', provider: 'searxng', endpoint: 'https://a.example', managed }] });
    };
    for (const bad of ['yes', 'true', 1, null, '', undefined]) {
      expect(() => withManaged(bad)).toThrow(NativeWebSearchFailure);
    }
    expect(parseNativeWebSearchView({ ...presentView(), profiles: [{ id: 'docs',
      display_name: 'docs', provider: 'searxng', endpoint: 'https://a.example',
      managed: true }] }).profiles[0]?.managed).toBe(true);
  });
  it('refuses a profile that names any provider other than the one NNA supports', () => {
    // NNA throws web_search_provider_invalid for these documents and the census row for
    // profiles[*].provider cites that refusal. Neither end had ever been tested with a
    // provider that is not SearXNG, so the single-legal-value claim rested on reading.
    for (const provider of ['google', 'SEARXNG', '', ' searxng', null, undefined]) {
      expect(() => parseNativeWebSearchView({ ...presentView(), profiles: [
        { id: 'docs', display_name: 'docs', provider, endpoint: 'https://a.example', managed: false }] }))
        .toThrow(NativeWebSearchFailure);
    }
    // The parser does not echo the served value back; it can only ever emit this one.
    expect(parseNativeWebSearchView(presentView()).profiles[0]?.provider).toBe('searxng');
  });
  it('canonicalizes endpoints exactly like the domain, collapsing /search and bare slashes', () => {
    expect(canonicalWebSearchEndpoint('HTTPS://Docs.Example.COM/search/')).toBe('https://docs.example.com');
    expect(canonicalWebSearchEndpoint('https://docs.example.com:8443')).toBe('https://docs.example.com:8443');
    expect(isValidWebSearchEndpointDraft('https://docs.example.com/search')).toBe(true);
    expect(isValidWebSearchEndpointDraft('https://user:pass@docs.example.com')).toBe(false);
    expect(isValidWebSearchEndpointDraft('ftp://docs.example.com')).toBe(false);
    expect(isValidWebSearchEndpointDraft('not a url')).toBe(false);
    expect(isValidWebSearchNameDraft('Docs search')).toBe(true);
    expect(isValidWebSearchNameDraft('   ')).toBe(false);
    expect(isValidWebSearchNameDraft('x'.repeat(129))).toBe(false);
  });
});

describe('web search settings operations', () => {
  it('canonicalizes drafted names and endpoints before transport', () => {
    expect(nativeWebSearchOperations([{ op: 'add_profile', display_name: '  Docs Search ', endpoint: 'https://d.example/search/' },
      { op: 'set_enabled', enabled: false }])
      .map(operation => JSON.stringify(operation).padEnd(1)))
      .toEqual([JSON.stringify({ op: 'add_profile', display_name: 'Docs Search', endpoint: 'https://d.example' }),
        JSON.stringify({ op: 'set_enabled', enabled: false })]);
  });
  it('enforces the bounded grammar and forwards the governed shape codes', () => {
    expect(() => nativeWebSearchOperations([])).toThrow(NativeWebSearchFailure);
    expect(() => nativeWebSearchOperations(Array.from({ length: 17 }, () => ({ op: 'promote_profile', id: 'a' }))))
      .toThrow(NativeWebSearchFailure);
    for (const bad of [{ op: 'add_profile', display_name: 'x', endpoint: 'https://a.example', extra: 1 }, { op: 'add_profile' },
      { op: 'set_enabled' }, { op: 'promote_profile' }, { op: 'remove_profile', id: 'UPPER' },
      { op: 'set_enabled', enabled: 'yes' }, { op: 'add_profile', display_name: '', endpoint: 'https://a.example' },
      { op: 'add_profile', display_name: 'x', endpoint: 'not a url' }]) {
      expect(() => nativeWebSearchOperations([bad])).toThrow(NativeWebSearchFailure);
    }
  });
  it('mirrors the store: add appends with the domain slug re-enabling, promote fronts, remove disables on empty', () => {
    const mirrored = projectNativeWebSearchOperations(absentView(), nativeWebSearchOperations([
      { op: 'add_profile', display_name: 'Docs Search', endpoint: 'https://docs.example' }]));
    expect(mirrored.profiles.map(item => item.id)).toEqual(['docs-search']);
    expect(mirrored.enabled).toBe(true);
    const promoted = projectNativeWebSearchOperations(presentView(), nativeWebSearchOperations([
      { op: 'promote_profile', id: 'work' }]));
    expect(promoted.profiles.map(item => item.id)).toEqual(['work', 'docs']);
    const removed = projectNativeWebSearchOperations(promoted, nativeWebSearchOperations([
      { op: 'remove_profile', id: 'work' }, { op: 'remove_profile', id: 'docs' }]));
    expect(removed.profiles).toEqual([]);
    expect(removed.enabled).toBe(false);
    const readded = projectNativeWebSearchOperations(removed, nativeWebSearchOperations([
      { op: 'add_profile', display_name: 'Again & more!!', endpoint: 'https://again.example' }]));
    expect(readded.profiles.map(item => item.id)).toEqual(['again-more']);
    expect(readded.enabled).toBe(true);
  });
  it('mirrors the domain refusals before any transport happens', () => {
    expect(() => projectNativeWebSearchOperations(absentView(), nativeWebSearchOperations([
      { op: 'set_enabled', enabled: true }]))).toThrow(expect.objectContaining({ code: 'web_search_endpoint_required' }));
    expect(() => projectNativeWebSearchOperations(presentView(), nativeWebSearchOperations([
      { op: 'add_profile', display_name: 'Clone', endpoint: 'https://a.example' }])))
      .toThrow(expect.objectContaining({ code: 'web_search_endpoint_duplicate' }));
    expect(() => projectNativeWebSearchOperations(presentView(), nativeWebSearchOperations([
      { op: 'promote_profile', id: 'ghost' }]))).toThrow(expect.objectContaining({ code: 'web_search_profile_missing' }));
  });
  it('composes the CAS request from the current view, absent basis included', () => {
    const request = nativeWebSearchRequest(absentView(), nativeWebSearchOperations([
      { op: 'add_profile', display_name: 'Docs', endpoint: 'https://docs.example' }]));
    expect(request).toEqual({ installation_id: 'install_ws', data_id: 'data_ws', scope: 'user',
      expected_revision: 'absent', expected_resolution_revision: 'absent',
      operations: [{ op: 'add_profile', display_name: 'Docs', endpoint: 'https://docs.example' }] });
    expect(() => nativeWebSearchRequest(presentView(), [])).toThrow(NativeWebSearchFailure);
  });
});
