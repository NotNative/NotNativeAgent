// SPDX-License-Identifier: Apache-2.0
/** P10-61 §G.7: idempotent wrapper, then composer response-style rider. */
import { describe, expect, it } from 'vitest';
import { wrapSystemReminder } from '../system-reminders.ts';
import { responseStyleReminder } from '../../chat/response-style.ts';

function wrapped(instruction: string) { return `<system-reminder>\n${instruction}\n</system-reminder>`; }

describe('system reminders', () => {
  it('trims non-empty text and avoids rewrapping compatible text', () => {
    expect(wrapSystemReminder('')).toBe('');
    expect(wrapSystemReminder('   ')).toBe('');
    expect(wrapSystemReminder('  proceed  ')).toBe(wrapped('proceed'));
    const source = wrapped('already wrapped');
    expect(wrapSystemReminder(source)).toBe(source);
  });

  it('does not trust a malformed wrapper as already wrapped', () => {
    expect(wrapSystemReminder('<system-reminder>text</system-reminder>')).toBe(wrapped('<system-reminder>text</system-reminder>'));
    expect(wrapSystemReminder('<system-reminder>text</system-reminder> ')).toBe(wrapped('<system-reminder>text</system-reminder>'));
  });

  it('rides settings only on enabled sends', () => {
    expect(responseStyleReminder({ responseStyleEnabled: false, responseStylePreset: 'mentor' })).toBe('');
    expect(responseStyleReminder({ responseStyleEnabled: true, responseStylePreset: 'mentor' })).toBe(wrapped('Respond as a mentor: explain the reasoning and teach transferable patterns.'));
    expect(responseStyleReminder({ responseStyleEnabled: true, responseStylePreset: 'unknown' })).toBe(wrapped('Respond concisely: answer the request directly and omit optional commentary.'));
    expect(responseStyleReminder({
      responseStyleEnabled: true,
      responseStylePreset: 'mentor',
      responseStyleCustomInstructions: '  prefer tables  ',
    })).toBe(wrapped('prefer tables'));
    expect(responseStyleReminder({
      responseStyleEnabled: true,
      responseStylePreset: 'custom',
      responseStyleCustomInstructions: '',
    })).toBe('');
  });
});
