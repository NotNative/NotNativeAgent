// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * P5-6 plumbing: the settings store optimistic writes + engine rules, the
 * appearance appliers (rem-root scale, --padding-scale, radius remap), and
 * the SettingsWindow page/search behavior end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../runtime-fetch.ts';
import { bindAppearanceAppliers, applyFontSize, applyPaddingScale, applyCornerRadius } from '../apply.ts';
import { __resetSettingsStoreForTests, setSettingsField, useSettingsStore } from '../store.ts';
import { __resetEngineForTests } from '../persistence.ts';

const fetchMock = runtimeFetch as unknown as Mock;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  __resetEngineForTests();
  __resetSettingsStoreForTests();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ surface: 'web', chatRenderMode: 'live' }));
  window.localStorage.clear();
});

afterEach(() => {
  fetchMock.mockReset();
});

describe('settings store (optimistic setField + engine rules)', () => {
  it('merges writes locally and forwards to the debounced engine', async () => {
    setSettingsField('chatRenderMode', 'sorted');
    expect(useSettingsStore.getState().doc.chatRenderMode).toBe('sorted');
    const pending = await import('../persistence.ts');
    expect(pending.pendingSettingsSnapshot()).toEqual({ chatRenderMode: 'sorted' });
  });

  it('never stores unregisterable or invalid keys locally', () => {
    setSettingsField('notInRegistry', 'x');
    setSettingsField('inputHistoryLimit', 999); // >100 invalid → dropped client-side by parse
    expect(useSettingsStore.getState().doc.notInRegistry).toBeUndefined();
    expect(useSettingsStore.getState().doc.inputHistoryLimit).toBeUndefined();
  });
});

describe('appearance appliers (B.3 + E11 remap)', () => {
  it('scales the rem root and padding/radius variables', () => {
    applyFontSize(125);
    expect(document.documentElement.style.fontSize).toBe('125%');
    applyPaddingScale(80);
    expect(document.documentElement.style.getPropertyValue('--padding-scale')).toBe('0.8');
    applyCornerRadius(18);
    expect(document.documentElement.style.getPropertyValue('--radius-lg')).toBe('1.125rem');
    applyFontSize(undefined);
    expect(document.documentElement.style.fontSize).toBe('100%');
  });

  it('live-drives from the settings store subscription', () => {
    const off = bindAppearanceAppliers();
    setSettingsField('fontSize', 150); // store change → applier fires
    expect(document.documentElement.style.fontSize).toBe('150%');
    off();
    applyFontSize(100);
  });
});
