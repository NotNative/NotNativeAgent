// SPDX-License-Identifier: Apache-2.0
/**
 * §I.3 recorder state machine gates: chord accumulation with the 3000 ms
 * readiness window, validation against live overrides, and the Confirm
 * contract (replaceable exact conflicts steal the loser to UNASSIGNED;
 * internal opponents block).
 */
import { describe, expect, it } from 'vitest';
import {
  recorderInitialState,
  recorderOnStroke,
  recorderOnTimeout,
  recorderExpiredWindow,
  recorderConfirm,
  recorderReset,
  type RecorderStroke,
} from '../recorder.ts';
import { parseCombo, UNASSIGNED_SHORTCUT } from '../bindings.ts';

const ACTION = 'focus_input';
const VOID_OVERRIDES: Record<string, string> = {};

const stroke = (key: string, ...mods: ('mod' | 'ctrl' | 'alt' | 'shift')[]): RecorderStroke => (
  { key, mods: new Set(mods) }
);

describe('recorder state machine (doc 14 §I.3)', () => {
  it('first chord waits for the second (await-second with binding)', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('i', 'mod'), ACTION, VOID_OVERRIDES);
    expect(state.phase).toBe('await-second');
    expect(state.binding).toBe('mod+i');
    expect(state.chords.length).toBe(1);
    expect(state.validation.kind).toBe('none');
  });

  it('second chord completes; exact conflict vs a customizable two-chord opponent is replaceable', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('k', 'mod'), 'focus_input', VOID_OVERRIDES); // rename's mod+k
    state = recorderOnStroke(state, stroke('r'), 'focus_input', VOID_OVERRIDES); // rename's r
    expect(state.phase).toBe('ready');
    expect(state.validation.kind).toBe('exact');
    expect(state.validation.otherActionId).toBe('rename_current_session');
    expect(state.validation.replaceable).toBe(true);
  });

  it('single-chord opponents vs two-chord candidates are PREFIX conflicts (§I.2)', () => {
    const overrides = { toggle_sidebar: 'mod+b' };
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('b', 'mod'), 'focus_input', overrides);
    state = recorderOnStroke(state, stroke('b', 'mod'), 'focus_input', overrides); // threatens the prefixed single
    expect(state.validation.kind).toBe('prefix');
    expect(state.validation.otherActionId).toBe('toggle_sidebar');
    expect(state.validation.replaceable).toBe(false); // prefix conflicts block per §I.3
  });

  it('internal opponents block: full-combo match is an irreplaceable exact', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('s', 'mod'), ACTION, VOID_OVERRIDES); // save_file mod+s
    expect(state.validation.kind).toBe('exact');
    expect(state.validation.replaceable).toBe(false);
    expect(state.validation.otherActionId).toBe('save_file');
  });

  it('two-chord candidates threatening an internal single are prefix-blocked', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('s', 'mod'), ACTION, VOID_OVERRIDES);
    state = recorderOnStroke(state, stroke('s', 'mod'), ACTION, VOID_OVERRIDES);
    expect(state.validation.kind).toBe('prefix'); // §I.2: single chords conflict with the family
    expect(state.validation.replaceable).toBe(false); // internal opponents never replace
  });

  it('identical two-chord conflicts exact; first-chord-only matches are prefix', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('k', 'mod'), 'focus_input', VOID_OVERRIDES);
    state = recorderOnStroke(state, stroke('r'), 'focus_input', VOID_OVERRIDES); // == rename's mod+k r
    expect(state.validation.kind).toBe('exact');
    let prefix = recorderInitialState();
    prefix = recorderOnStroke(prefix, stroke('k', 'mod'), 'focus_input', VOID_OVERRIDES);
    prefix = recorderOnStroke(prefix, stroke('z'), 'focus_input', VOID_OVERRIDES); // shares mod+k only
    expect(prefix.validation.kind).toBe('prefix'); // an arbitrary family member is the named opponent
  });

  it('timeout turns a one-chord recording ready (single-chord rebind)', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('i', 'mod'), ACTION, VOID_OVERRIDES);
    expect(recorderExpiredWindow(state, (state.startedAt ?? 0) + 3001)).toBe(true);
    state = recorderOnTimeout(state);
    expect(state.phase).toBe('ready');
    expect(state.binding).toBe('mod+i');
  });

  it('confirm with an exact replaceable conflict steals the loser to UNASSIGNED', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('k', 'mod'), 'focus_input', VOID_OVERRIDES);
    state = recorderOnStroke(state, stroke('r'), 'focus_input', VOID_OVERRIDES);
    const result = recorderConfirm(state, 'focus_input', VOID_OVERRIDES);
    expect(result.blocked).toBe(false);
    expect(result.overrides.focus_input).toBe('mod+k r');
    expect(result.overrides.rename_current_session).toBe(UNASSIGNED_SHORTCUT);
    expect(parseCombo(UNASSIGNED_SHORTCUT).chords.length).toBe(0);
  });

  it('confirm is blocked while a conflict is not replaceable', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('s', 'mod'), ACTION, VOID_OVERRIDES);
    const result = recorderConfirm(state, ACTION, VOID_OVERRIDES);
    expect(result.blocked).toBe(true);
  });

  it('single-chord recordings confirm alone; reset restarts cleanly', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('g', 'alt'), ACTION, VOID_OVERRIDES);
    state = recorderOnTimeout(state); // window elapsed in the dialog tick
    const result = recorderConfirm(state, ACTION, VOID_OVERRIDES);
    expect(result.blocked).toBe(false);
    expect(parseCombo(result.binding!).chords.length).toBe(1);
    state = recorderReset(state);
    expect(state.binding).toBeNull();
    expect(state.phase).toBe('idle');
  });

  it('a chord over 3 physical keys is rejected with the exceeded marker', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('k', 'mod', 'ctrl', 'alt'), ACTION, VOID_OVERRIDES);
    expect(state.exceeded).toBe(true);
    expect(state.binding).toBeNull(); // nothing recorded
    state = recorderOnStroke(state, stroke('k', 'mod'), ACTION, VOID_OVERRIDES); // recovers
    expect(state.exceeded).toBe(false);
    expect(state.binding).toBe('mod+k');
  });

  it('window boundary: exactly 3000 ms is INSIDE, 3001 outside (strict >)', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('i', 'mod'), ACTION, VOID_OVERRIDES);
    expect(recorderExpiredWindow(state, (state.startedAt ?? 0) + 3000)).toBe(false);
    expect(recorderExpiredWindow(state, (state.startedAt ?? 0) + 3001)).toBe(true);
  });

  it('modifier-only strokes never progress the machine', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('shift'), ACTION, VOID_OVERRIDES);
    expect(state.phase).toBe('idle'); // strokeKeyLegit rejects bare modifiers
    expect(state.binding).toBeNull();
  });

  it('browser-risk feedback lands on reserved combos (§I.3 + P5-5 chordRisk)', () => {
    let state = recorderInitialState();
    state = recorderOnStroke(state, stroke('t', 'mod'), ACTION, VOID_OVERRIDES);
    expect(state.risk).toBe('browser-reserved');
    state = recorderOnStroke(state, stroke('x', 'mod'), ACTION, VOID_OVERRIDES);
    state = recorderOnStroke(state, stroke('r'), ACTION, VOID_OVERRIDES); // mod+k r is safe
    expect(state.risk).toBe('ok');
  });
});
