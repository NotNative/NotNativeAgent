// SPDX-License-Identifier: Apache-2.0
/**
 * Shared CLI argument parser (doc 03 S10.1): long flags plus the
 * `--flag=value` form; short aliases are declared per spec; boolean flags
 * accept `--no-<name>` to record false. Unknown options are usage errors
 * (exit 2). Validation runs in every output mode.
 */

export class CliUsageError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'CliUsageError';
    this.exitCode = exitCode;
  }
}

export type FlagKind = 'boolean' | 'string' | 'number';

export interface FlagSpec {
  name: string;
  kind: FlagKind;
  /** `-p` style short form. */
  short?: string;
  /** Extra long aliases (e.g. hostname for host). */
  aliases?: string[];
}

export type FlagValue = string | number | boolean | undefined;

export interface ParsedInvocation {
  command: string | null;
  flags: Record<string, FlagValue>;
}

interface TokenMatch {
  unknown: string | null;
  spec: FlagSpec | null;
  inline: string | undefined;
  negate: boolean;
}

const TRUE_FALSE = new Set(['true', 'false']);

function findSpec(name: string, specs: FlagSpec[]): FlagSpec | null {
  for (const spec of specs) {
    const short = spec.short?.replace(/^-/u, '');
    if ((short !== undefined && short === name) || spec.name === name) return spec;
  }
  return null;
}

function matchLong(name: string, specs: FlagSpec[]): TokenMatch {
  let negate = false;
  let spec = findSpec(name, specs);
  if (spec === null && name.startsWith('no-')) {
    spec = findSpec(name.slice(3), specs);
    negate = spec !== null && spec.kind === 'boolean';
  }
  if (spec === null) return { unknown: name, spec: null, inline: undefined, negate };
  return { unknown: null, spec, inline: undefined, negate };
}

function matchToken(token: string, specs: FlagSpec[]): { match: TokenMatch; inline: string | undefined } {
  if (token.startsWith('--')) {
    const body = token.slice(2);
    const eqAt = body.indexOf('=');
    const name = (eqAt === -1 ? body : body.slice(0, eqAt)).trim();
    const inline = eqAt === -1 ? undefined : body.slice(eqAt + 1);
    return { match: matchLong(name, specs), inline };
  }
  const short = token.slice(1);
  const spec = findSpec(short, specs);
  return { match: { unknown: spec === null ? short : null, spec, inline: undefined, negate: false }, inline: undefined };
}

function setFlag(target: Record<string, FlagValue>, spec: FlagSpec, value: FlagValue): void {
  target[spec.name] = spec.name === 'host' && value === true ? '0.0.0.0' : value;
}

function coerceValue(spec: FlagSpec, value: string): FlagValue {
  if (spec.kind === 'number') {
    // Numbers reject junk at the parse surface (S10.1: the 1..65535 range
    // error wording stays in the command; here we refuse non-numeric input
    // including empty strings, e.g. `--port=` or `-p ''`).
    if (value === '') throw new CliUsageError(`--${spec.name} expects a number, got ""`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new CliUsageError(`--${spec.name} expects a number, got "${value}"`);
    return parsed;
  }
  return value;
}

/** Parse one invocation; the first non-flag token becomes `command`. */
export function parseInvocation(tokens: readonly string[], specs: FlagSpec[]): ParsedInvocation {
  const flags: Record<string, FlagValue> = {};
  let command: string | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (!token.startsWith('-')) {
      if (command !== null) throw new CliUsageError(`unexpected argument "${token}" `);
      command = token;
      continue;
    }
    const { match, inline } = matchToken(token, specs);
    const spec = match.spec;
    if (spec === null) {
      const presented = token.startsWith('--') ? `--${match.unknown ?? token.slice(2)}` : `-${match.unknown ?? token.slice(1)}`;
      throw new CliUsageError(`unknown option "${presented}" `);
    }
    if (spec.kind === 'boolean') {
      if (inline !== undefined) {
        if (!TRUE_FALSE.has(inline)) throw new CliUsageError(`--${spec.name} expects true|false `);
        setFlag(flags, spec, inline === 'true');
      } else {
        setFlag(flags, spec, !match.negate);
      }
      continue;
    }
    if (inline !== undefined) {
      setFlag(flags, spec, coerceValue(spec, inline));
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new CliUsageError(`--${spec.name} requires a value `);
    }
    setFlag(flags, spec, coerceValue(spec, next));
    index += 1;
  }
  return { command, flags };
}

/** Suggestion helper (S10): names within `maxEdits` of the unknown word. */
export function suggestCloseMatches(input: string, candidates: readonly string[], maxEdits = 3): string[] {
  const target = input.toLowerCase();
  if (target.length === 0) return [];
  const edits: Array<{ name: string; distance: number }> = [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const distance = levenshtein(target, lower, maxEdits);
    const record = { name: candidate, distance };
    if (distance <= maxEdits) edits.push(record);
  }
  return edits.sort((a, b) => a.distance - b.distance).map((entry) => entry.name);
}

function levenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const previous: number[] = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row(previous, 0);
    previous[0] = i;
    const charA = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      const old = row(previous, j);
      previous[j] = Math.min(old + 1, row(previous, j - 1) + 1, diagonal + (charA === b[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return row(previous, b.length);
}

function row(rowValues: readonly number[], index: number): number {
  const value = rowValues[index];
  return value === undefined ? capValue : value;
}

const capValue = Number.MAX_SAFE_INTEGER;
