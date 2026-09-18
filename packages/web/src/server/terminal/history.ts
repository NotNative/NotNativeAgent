// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal history sanitizer (doc 07 section 3.4 / C.5): replay text is
 * clean of OSC 10/11/12 query+reply exchanges, DSR/DA/CPR exchanges, and
 * Mode-2031 (DECRQM) query/report/set sequences; INCOMPLETE sequences are
 * carried across chunk boundaries so nothing is stripped half-cut or left
 * duplicated. Live bytes `d` are never touched. History caps at 512 KiB per
 * session with a UTF-8-safe cut (never mid-continuation).
 */
import { Buffer } from 'node:buffer';

export const TERMINAL_HISTORY_MAX_BYTES = 512 * 1024;
/** Safety bound (E-07-6): an UNTERMINATED sequence bridges chunks only
 * while it stays under this size; beyond it the sequence is abandoned and
 * scanning resumes after the escape intro (a runaway body can never grow
 * the carried partial without bound). */
export const PARTIAL_SEQUENCE_LIMIT = 8192;
const ESC = '\u001b';

export interface HistorySanitizer {
  /** Feed a byte-safe JS string; returns the REPLAY-SAFE text. */
  push(text: string): string;
  /** Flush a trailing partial sequence as raw text (end of stream). */
  flush(): string;
}

interface SanitizerState {
  /** Carried-over partial control sequence from the previous chunk. */
  partial: string;
}

export function createHistorySanitizer(): HistorySanitizer {
  const state: SanitizerState = { partial: '' };
  return {
    push: (text: string): string => sanitize(state, text),
    flush: (): string => {
      const tail = state.partial;
      state.partial = '';
      return tail;
    },
  };
}

function sanitize(state: SanitizerState, text: string): string {
  const combined = state.partial + text;
  state.partial = '';
  let out = '';
  let index = 0;
  while (index < combined.length) {
    const esc = combined.indexOf(ESC, index);
    if (esc < 0) {
      out += combined.slice(index);
      return out;
    }
    out += combined.slice(index, esc);
    if (esc + 1 >= combined.length) {
      state.partial = ESC; // sequence opens, completes next chunk
      return out;
    }
    const intro = combined[esc + 1];
    const next = esc + 2;
    if (intro === '[') {
      const end = findCsiEnd(combined, next);
      if (end < 0) {
        const carried = carryPartialSequence(state, combined, esc);
        if (carried < 0) return out;
        index = carried; // oversized unterminated sequence: abandoned (E-07-6)
        continue;
      }
      const sequence = combined.slice(esc, end);
      if (!isQueryExchange(combined.slice(esc + 1, end))) out += sequence; // classify on the ESC-less body; plain CSI/DECSET survive
      index = end;
      continue;
    }
    if (intro === ']' || intro === 'P' || intro === 'X' || intro === '^' || intro === '_') {
      const end = findStringEnd(combined, next); // OSC/DCS/SOS/PM/APC: BEL or ESC backslash; never printable replay
      if (end < 0) {
        const carried = carryPartialSequence(state, combined, esc);
        if (carried < 0) return out;
        index = carried;
        continue;
      }
      index = end;
      continue;
    }
    if (intro === '\\') {
      index = next; // stray ST: nothing to strip
      continue;
    }
    out += combined.slice(esc, Math.min(next, combined.length));
    index = next;
  }
  return out;
}

/** Bounded cross-chunk carry shared with the theme scanner (E-07-6):
 * returns -1 when the unterminated sequence is carried to the next chunk;
 * an unterminated body beyond PARTIAL_SEQUENCE_LIMIT is ABANDONED together
 * with the rest of its chunk (bounded loss, no runaway partial, no leak). */
export function carryPartialSequence(state: { partial: string }, combined: string, esc: number): number {
  if (combined.length - esc > PARTIAL_SEQUENCE_LIMIT) {
    state.partial = ''; // abandon the runaway unterminated sequence
    return combined.length;
  }
  state.partial = combined.slice(esc);
  return -1; // sequence opens, completes next chunk
}

function findCsiEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
  }
  return -1;
}

function findStringEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x07) return i + 1;
    if (code === 0x1b && text[i + 1] === '\\') return i + 2;
  }
  return -1;
}

/** section 3.4: strip ONLY query/reply exchanges - OSC 10/11/12 (string
 * handled in sanitize), DA replies, DSR/status reports (5n incl. 996/997
 * answers), CPR, DECRQM 2031 request/report/set-reset. Everything else
 * (SGR, cursor moves, DECSET such as ?1004/?2004) is printable replay. */
export function isQueryExchange(sequence: string): boolean {
  if (/^\[\?[0-9;]*c$/u.test(sequence)) return true; // DA replies (?1;2 c)
  if (/^\[[0-9;]*n$/u.test(sequence)) return true; // DSR status + 996/997 reports
  if (/^\[[0-9;]*R$/u.test(sequence)) return true; // CPR
  if (/^\[\?[0-9;]*[$]p$/u.test(sequence)) return true; // DECRQM request (D? parameters)
  if (/^\[\?[0-9]+;\d+[$]y$/u.test(sequence)) return true; // DECRQM report
  if (/^\[\?2031[hl]$/u.test(sequence)) return true; // Mode 2031 set/reset
  return false;
}

/** UTF-8-safe tail (512 KiB rule): keep the last maxBytes bytes, cut on a
 * whole-character boundary (never mid-continuation). */
export function utf8SafeTail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}
