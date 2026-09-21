// SPDX-License-Identifier: Apache-2.0
/**
 * P8-8 invariants sweep (§12.1/§12.3 rows): the ui runtime credentials
 * live in module memory only and Authorization never reaches anything
 * but the header it authenticates. Pins: extra-header laundering drops
 * `Authorization` at the setRuntimeExtraHeaders parse side (runtimeConfig
 * already filters it at injection), the bearer stays memory-only between
 * initialize/set/apply, and credential seams reset cleanly for tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRuntimeAuthHeaders,
  initializeRuntimeCredentials,
  setRuntimeBearerToken,
  setRuntimeExtraHeaders,
} from '../runtime-auth.ts';
import { getInjectedRuntimeHeaders } from '../runtimeConfig.ts';

afterEach(() => {
  setRuntimeBearerToken(null);
  setRuntimeExtraHeaders({});
});

describe('runtime credentials (§12.3 memory-only, no shared-stored token)', () => {
  it('setRuntimeExtraHeaders never keeps an Authorization entry (parse-side filter)', () => {
    setRuntimeExtraHeaders({ 'x-device': 'mobile', Authorization: 'Bearer stolen', authorization: 'Bearer stolen-lower' });
    const headers = applyRuntimeAuthHeaders(new Headers());
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-device')).toBe('mobile');
    expect(getInjectedRuntimeHeaders()).toEqual({}); // node surface: no window globals, empty in — same posture
  });

  it('bearer applies once and never leaves memory (no injection, no storage)', () => {
    applyRuntimeAuthHeaders(new Headers()); // initialize-runtime default is tokenless on the node surface
    setRuntimeBearerToken('oc_client_abc');
    const out = applyRuntimeAuthHeaders(new Headers());
    expect(out.get('authorization')).toBe('Bearer oc_client_abc');
    expect(applyRuntimeAuthHeaders(out).get('authorization')).toBe('Bearer oc_client_abc'); // set-once discipline
    const flushed = new Headers();
    flushed.set('authorization', 'Bearer existing');
    applyRuntimeAuthHeaders(flushed);
    expect(flushed.get('authorization')).toBe('Bearer existing'); // never overwrites a caller-set header
  });

  it('initializeRuntimeCredentials resolves tokenless without injected globals and accepts a later bearer', () => {
    initializeRuntimeCredentials();
    expect(applyRuntimeAuthHeaders(new Headers()).get('authorization')).toBeNull();
    setRuntimeBearerToken('oc_client_late');
    expect(applyRuntimeAuthHeaders(new Headers()).get('authorization')).toBe('Bearer oc_client_late');
  });
});
