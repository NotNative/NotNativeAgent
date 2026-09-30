// SPDX-License-Identifier: Apache-2.0
/** §B.10 response-style rider; §G.7 provides the wrapper shape. */
import { wrapSystemReminder } from '../lib/system-reminders.ts';
import { settingsValue } from '../lib/settings/store.ts';

const PRESET_TEXT: Record<string, string> = {
  concise: 'Respond concisely: answer the request directly and omit optional commentary.',
  detailed: 'Respond in detail: cover relevant context, tradeoffs, and next steps where useful.',
  mentor: 'Respond as a mentor: explain the reasoning and teach transferable patterns.',
  pushback: 'Respond with critical review: identify risks, invalid assumptions, and a stronger alternative.',
  noFiller: 'Respond without filler: no preamble, conclusions, praise, or restatement of the request.',
  matchEnergy: 'Match the request tone and detail level without changing its meaning.',
  warmPeer: 'Respond as a warm, collaborative peer: practical, encouraging, and direct.',
};

export function responseStyleReminder(settings: Record<string, unknown>): string {
  if (settings.responseStyleEnabled !== true) return '';
  const custom = typeof settings.responseStyleCustomInstructions === 'string'
    ? settings.responseStyleCustomInstructions.trim() : '';
  if (custom !== '') return wrapSystemReminder(custom);
  const preset = typeof settings.responseStylePreset === 'string' ? settings.responseStylePreset : '';
  if (preset === 'custom') return '';
  return responseStyleReminder({ ...settings, responseStyleCustomInstructions: PRESET_TEXT[preset] ?? PRESET_TEXT.concise });
}

export function responseStyleRider(sessionID: string | null, messages: unknown[], activeBtw: boolean): string {
  if (activeBtw || (sessionID !== null && messages.length !== 0)) return '';
  return responseStyleReminder({
    responseStyleEnabled: settingsValue('responseStyleEnabled'),
    responseStylePreset: settingsValue('responseStylePreset'),
    responseStyleCustomInstructions: settingsValue('responseStyleCustomInstructions') });
}
