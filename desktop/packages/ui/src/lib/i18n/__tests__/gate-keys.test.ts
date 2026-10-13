// SPDX-License-Identifier: Apache-2.0
/**
 * Auth-gate i18n registration (W-64): every GATE_TEXT literal must have a
 * registered auth.gate.* dictionary entry with the SAME value, so the
 * translated surface and the bare-mount fallback can never drift apart.
 */
import { describe, expect, it } from 'vitest';

import en, { type I18nKey } from '../messages/en.ts';
import { GATE_KEY, GATE_TEXT } from '../../../components/auth/gateText.ts';

describe('auth gate copy registration', () => {
  it('registers every gate string under auth.gate.* with the same EN value', () => {
    const keys = Object.keys(GATE_TEXT) as Array<keyof typeof GATE_TEXT>;
    expect(keys.length).toBeGreaterThanOrEqual(16);
    for (const key of keys) {
      const registered = GATE_KEY[key];
      expect(registered.startsWith('auth.gate.')).toBe(true);
      expect(en[registered as I18nKey]).toBe(GATE_TEXT[key]);
    }
  });

  it('every GATE_KEY value is a real dictionary key', () => {
    for (const value of Object.values(GATE_KEY)) {
      expect(Object.hasOwn(en, value)).toBe(true);
    }
  });
});
