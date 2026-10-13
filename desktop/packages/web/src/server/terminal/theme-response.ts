// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal theme-response answering (doc 07 section 4.6): a terminal with
 * NO renderer attached still must answer VT queries - Fish polls DA1 at
 * startup and would block ~10 s otherwise. While draining output the server
 * scans for OSC 10/11 queries (fg/bg), DSR status, DA1, Mode-2031
 * (DECRQM) request/set/reset, and the 996/997 theme reports; it answers
 * from the stored appearance, tracks Mode-2031 enablement, and strips every
 * answered exchange from the published bytes - replies go straight into the
 * PTY, never into history/replay. Incomplete sequences carry across chunks
 * (independent state from the history sanitizer, same bounded carry).
 */
import { carryPartialSequence } from './history.ts';

const ESC = '\u001b';
const OSC_BODY_PATTERN = /^\u001b\](10|11);\?(\u0007|\u001b\\)$/u;

interface ThemeState {
  partial: string;
  mode2031: boolean;
  themeMode: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
}

export interface ThemeScanResult {
  /** PTY passthrough with answered exchanges REMOVED (these become `r`). */
  clean: string;
  /** Sequences to write back into the PTY (fills query answers). */
  replies: string;
}

export interface ThemeQuestionAnswerer {
  push(text: string): ThemeScanResult;
  /** Whether the program enabled Mode 2031 (theme notify subscriber). */
  mode2031(): boolean;
  /** section 4.6: on appearance change, each live session with Mode 2031
   * enabled receives CSI ? 997 ; 1|2 n (1 dark, 2 light). */
  themeNotify(themeMode: 'light' | 'dark'): string;
}

export function createThemeQuestionAnswerer(appearance: { themeMode: 'light' | 'dark'; terminalBackground?: string; terminalForeground?: string }): ThemeQuestionAnswerer {
  const state: ThemeState = {
    partial: '',
    mode2031: false,
    themeMode: appearance.themeMode,
    terminalBackground: appearance.terminalBackground,
    terminalForeground: appearance.terminalForeground,
  };
  return {
    push: (text: string): ThemeScanResult => scanTheme(state, text),
    mode2031: (): boolean => state.mode2031,
    themeNotify: (themeMode: 'light' | 'dark'): string => `\u001b[?997;${themeMode === 'dark' ? 1 : 2}n`,
  };
}

function scanTheme(state: ThemeState, text: string): ThemeScanResult {
  const combined = state.partial + text;
  state.partial = '';
  const result: ThemeScanResult = { clean: '', replies: '' };
  let index = 0;
  while (index < combined.length) {
    const esc = combined.indexOf(ESC, index);
    if (esc < 0) {
      result.clean += combined.slice(index);
      break;
    }
    result.clean += combined.slice(index, esc);
    if (esc + 1 >= combined.length) {
      state.partial = ESC; // sequence opens, completes next chunk
      break;
    }
    const next = scanThemeAt(state, combined, esc, result);
    if (next < 0) break; // incomplete sequence carried into state.partial
    index = next;
  }
  return result;
}

/** Consumes ONE escape introduced at `esc`; returns the next scan index,
 * or -1 when the sequence is incomplete (kept for the next chunk). */
function scanThemeAt(state: ThemeState, combined: string, esc: number, result: ThemeScanResult): number {
  const intro = combined[esc + 1];
  const next = esc + 2;
  if (intro === '[') {
    return scanThemeCsi(state, combined, esc, next, result);
  }
  if (intro === ']' || intro === 'P' || intro === 'X' || intro === '^' || intro === '_') {
    return scanThemeString(state, combined, esc, next, result);
  }
  if (intro === '\\') return next; // stray ST
  result.clean += combined.slice(esc, Math.min(next, combined.length));
  return next;
}

function scanThemeCsi(state: ThemeState, combined: string, esc: number, next: number, result: ThemeScanResult): number {
  const end = findCsiEnd(combined, next);
  if (end < 0) return carryPartialSequence(state, combined, esc);
  const reply = answerCsi(state, combined.slice(esc, end));
  if (reply === null) result.clean += combined.slice(esc, end); // ordinary control: printer-visible
  else result.replies += reply; // answered: stripped from output, written into the PTY
  return end;
}

function scanThemeString(state: ThemeState, combined: string, esc: number, next: number, result: ThemeScanResult): number {
  const end = findStringEnd(combined, next);
  if (end < 0) return carryPartialSequence(state, combined, esc); // runaway bodies abandoned (E-07-6)
  const reply = answerOsc(state, combined.slice(esc, end));
  if (reply !== null) result.replies += reply; // answered OSC bodies are stripped entirely
  return end;
}

/** section 4.6 answers, or null when the sequence is an ordinary control
 * that must pass through untouched. Track Mode 2031 enablement in state. */
function answerCsi(state: ThemeState, sequence: string): string | null {
  if (sequence === '\u001b[5n') return '\u001b[0n'; // DSR status: OK
  if (sequence === '\u001b[c' || sequence === '\u001b[0c') return '\u001b[?1;2c'; // DA1 conservative VT100 (Fish)
  if (/^\u001b\[\?2031[hl]$/u.test(sequence)) {
    state.mode2031 = sequence.endsWith('h');
    return ''; // tracked, stripped, no reply
  }
  if (sequence === '\u001b[?2031$p') return `\u001b[?2031;${state.mode2031 ? 1 : 2}$y`;
  if (sequence === '\u001b[?996n' || sequence === '\u001b[?997n') {
    return `\u001b[?997;${state.themeMode === 'dark' ? 1 : 2}n`;
  }
  if (/^\u001b\[[0-9;]*n$/u.test(sequence)) return ''; // other DSR: answered nothing; stripped (CPR needs a renderer)
  if (/^\u001b\[[0-9;]*R$/u.test(sequence)) return ''; // CPR: stripped, never answered (renderer owns it post-attach)
  return null; // ordinary sequence: passthrough
}

/** OSC 10 ; ? (foreground) / OSC 11 ; ? (background), BEL or ST ended.
 * null = not a color query: the body is dropped, never replayed. */
function answerOsc(state: ThemeState, body: string): string | null {
  const match = OSC_BODY_PATTERN.exec(body);
  if (match === null) return null;
  const requested = match[1] === '10' ? state.terminalForeground : state.terminalBackground;
  const missing = match[1] === '10' ? '#ffffff' : '#000000'; // per-entry fallback, never garbage (doc 5.7)
  return `\u001b]${match[1]};${cssColorToRgb(requested ?? missing)}\u001b\\`;
}

/** Hex (#rgb/#rrggbb ignores alpha), rgb()/rgba() (ints or floats); per-
 * entry parse failure falls back rather than sending garbage (doc 5.7 rule
 * applied server-side). Output is 16-bit-per-channel `rgb:rrrr/gggg/bbbb`
 * (byte * 257, the X11 convention for 8-bit sources). */
export function cssColorToRgb(css: string | undefined, fallback24 = '#ffffff'): string {
  const value = normalizeCssColor(css) ?? normalizeCssColor(fallback24);
  const rgb = parseCssColor(value!);
  const channels = rgb.map((byte) => (Math.round(byte) * 257).toString(16).padStart(4, '0')).join('/');
  return `rgb:${channels}`;
}

function normalizeCssColor(css: string | undefined): string | null {
  return typeof css === 'string' && css.trim().length > 0 ? css.trim() : null;
}

function parseCssColor(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(value);
  if (hex !== null) return parseHexColor(hex[1]!);
  const fn = /^(rgba?)\(([^)]+)\)$/iu.exec(value);
  if (fn !== null) return parseFnColor(fn[1]!, fn[2]!);
  return [255, 255, 255]; // parse failure: white fallback (never send garbage)
}

function parseHexColor(digits: string): [number, number, number] {
  const six = digits.length === 3 ? digits.split('').map((digit) => digit + digit).join('') : digits.slice(0, 6).padEnd(6, '0');
  return [0, 2, 4].map((offset) => parseInt(six.slice(offset, offset + 2), 16)) as [number, number, number];
}

function parseFnColor(kind: string, body: string): [number, number, number] {
  void kind; // rgb() and rgba() read the first three channels the same way
  const parts = body.split(',').slice(0, 3).map((part) => {
    const number = parseFloat(part.trim());
    return Number.isFinite(number) ? (number <= 1 ? Math.round(number * 255) : Math.round(number)) : 255;
  });
  return parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : [255, 255, 255];
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
