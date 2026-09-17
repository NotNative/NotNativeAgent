// SPDX-License-Identifier: Apache-2.0
/**
 * Shortcut recording state machine (doc 14 §I.3): records up to 2 chords
 * (≤3 simultaneous physical keys per chord); after the first chord it waits
 * up to 3000 ms for the second, then the one-chord recording becomes ready.
 * Enter and Escape ARE recordable chords. Conflicts evaluate against the
 * FULL schema with live overrides (internals authoritative, never
 * replaceable); everything stays local until Confirm.
 */
import { parseCombo, comboToString, UNASSIGNED_SHORTCUT, SEQUENCE_TIMEOUT_MS, chordRisk, type Chord } from './bindings.ts';
import { recorderConflict } from './dispatcher.ts';

export type RecorderPhase = 'idle' | 'recording' | 'await-second' | 'ready';

export interface RecorderStroke {
  key: string;
  mods: Set<'mod' | 'ctrl' | 'alt' | 'shift'>;
}

export interface RecorderValidation {
  kind: 'exact' | 'prefix' | 'none';
  replaceable: boolean;
  otherActionId: string | null;
}

export interface RecorderState {
  phase: RecorderPhase;
  chords: Chord[];
  validation: RecorderValidation;
  /** The stroke that would exceed 3 physical keys per chord. */
  exceeded: boolean;
  /** §I.3 browser-risk feedback (after the second chord / timeout / confirm). */
  risk: 'browser-reserved' | 'ok';
  binding: string | null;
  startedAt?: number;
}

export function recorderInitialState(): RecorderState {
  return {
    phase: 'idle',
    chords: [],
    validation: { kind: 'none', replaceable: false, otherActionId: null },
    exceeded: false,
    risk: 'ok',
    binding: null,
  };
}

const EMPTY_VALIDATION: RecorderValidation = { kind: 'none', replaceable: false, otherActionId: null };
const PHYS_KEYS_PER_CHORD = 3;

function strokeKeyLegit(stroke: RecorderStroke): boolean {
  return stroke.key.length > 0 && !['control', 'alt', 'shift', 'meta'].includes(stroke.key);
}

function toChord(stroke: RecorderStroke): Chord {
  return { mods: new Set(stroke.mods), key: stroke.key };
}

function validate(actionId: string, chords: Chord[], overrides: Record<string, string>): RecorderValidation {
  if (chords.length === 0) return EMPTY_VALIDATION;
  const candidate = parseCombo(comboToString({ chords }));
  return recorderConflict(actionId, candidate, overrides);
}

function validateRisk(chords: Chord[]): 'browser-reserved' | 'ok' {
  return chordRisk({ chords });
}

/** Pure transition for one normalized stroke pair (chord + timestamp). */
export function recorderOnStroke(
  state: RecorderState,
  stroke: RecorderStroke,
  actionId: string,
  overrides: Record<string, string>,
): RecorderState {
  if (!strokeKeyLegit(stroke)) return state;
  if (state.phase === 'idle' || state.phase === 'ready') {
    const chord = toChord(stroke);
    if (chord.mods.size + 1 > PHYS_KEYS_PER_CHORD) return { ...state, exceeded: true };
    const chords = [chord];
    return {
      ...state,
      phase: 'await-second',
      chords,
      startedAt: Date.now(),
      binding: comboToString({ chords }),
      validation: validate(actionId, chords, overrides),
      risk: validateRisk(chords),
      exceeded: false,
    };
  }
  // await-second: a MODIFIER-ONLY press does not progress; any key does.
  if (state.chords.length >= 2) return state;
  const chord = toChord(stroke);
  if (stroke.mods.size + 1 > PHYS_KEYS_PER_CHORD) return { ...state, exceeded: true };
  const chords = [...state.chords, chord];
  return {
    ...state,
    phase: 'ready',
    chords,
    binding: comboToString({ chords }),
    validation: validate(actionId, chords, overrides),
    risk: validateRisk(chords),
    exceeded: false,
  };
}

/** Timer drive: the 3000 ms window turns a one-chord recording ready. */
export function recorderOnTimeout(state: RecorderState): RecorderState {
  if (state.phase !== 'await-second') return state;
  return { ...state, phase: 'ready' };
}

export function recorderExpiredWindow(state: RecorderState, now: number): boolean {
  return state.phase === 'await-second' && (state.startedAt === undefined || now - state.startedAt > SEQUENCE_TIMEOUT_MS);
}

export function recorderReset(state: RecorderState): RecorderState {
  return recorderInitialState();
}

/** Confirm (§I.3): exact customizable conflicts REPLACE the loser with the
 * sentinel; blocked conflicts stay local until resolved. */
export function recorderConfirm(
  state: RecorderState,
  actionId: string,
  overrides: Record<string, string>,
): { overrides: Record<string, string>; blocked: boolean; binding: string | null } {
  if (state.phase !== 'ready' || state.binding === null) return { overrides, blocked: true, binding: null };
  if (state.validation.otherActionId !== null && !state.validation.replaceable) {
    return { overrides, blocked: true, binding: state.binding };
  }
  const next: Record<string, string> = { ...overrides, [actionId]: state.binding };
  if (state.validation.kind === 'exact' && state.validation.otherActionId !== null) {
    next[state.validation.otherActionId] = UNASSIGNED_SHORTCUT;
  }
  return { overrides: next, blocked: false, binding: state.binding };
}
