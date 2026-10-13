// SPDX-License-Identifier: Apache-2.0
/**
 * CLI output engine (doc 03 S10/§10.4/S10.3): three output modes per command —
 * human (TTY decorations), `--quiet` (compact deterministic lines), `--json`
 * (one document on stdout, nothing else) — with `--json` winning when both
 * are set. Human decorations drop for a piped stdout, NO_COLOR, or --plain.
 * Validation and policy run in every mode.
 */

export const EXIT_CODES = {
  ok: 0,
  general: 1,
  usage: 2,
  dependency: 3,
  auth: 4,
  network: 5,
} as const;

export const SIGINT_EXIT_CODE = 130;

export interface OutputFlags {
  json?: string | number | boolean | undefined;
  quiet?: string | number | boolean | undefined;
  plain?: string | number | boolean | undefined;
}

export interface ResolvedOutputMode {
  mode: 'json' | 'quiet' | 'human';
  human: boolean;
}

/** S10 exit-code class 5 (network/runtime): process-lane failures such as an
 *  auto-spawned server not answering /health. Carries its exit code so bin.ts
 *  maps it without a type list. */
export class CliRuntimeError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODES.network) {
    super(message);
    this.name = 'CliRuntimeError';
    this.exitCode = exitCode;
  }
}

export function resolveOutputMode(flags: OutputFlags): ResolvedOutputMode {
  if (flags.json === true) return { mode: 'json', human: false };
  if (flags.quiet === true) return { mode: 'quiet', human: false };
  const human = process.stdout.isTTY === true
    && process.env.NO_COLOR !== '1'
    && flags.plain !== true;
  return { mode: 'human', human };
}

export function renderJsonDocument(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

/** `messages[].level` normalization (S10): one of ok|warning|error. */
export type CliMessageLevel = 'ok' | 'warning' | 'error';

export interface CliMessage {
  level: CliMessageLevel;
  code: string;
  message: string;
}

function line(input: string): void {
  process.stdout.write(`${input}\n`);
}

/** Warnings/fails reach a piped stdout too (S10.3: validation in every mode);
 *  only the clack-style decorations are TTY/NO_COLOR gated. */
function decorate(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR !== '1';
}

/** Human-mode intro/outro decorations (clack-style geometry, no dep). */
export const HUMAN = {
  intro: (text: string): void => { if (decorate()) line(`N  ${text}`); },
  outro: (text: string): void => { if (decorate()) line(`√  ${text}`); },
  info: (text: string): void => { line(`i  ${text}`); },
  warning: (text: string): void => { line(`●  ${text}`); },
  fail: (text: string): void => { line(`×  ${text}`); },
  line,
};

/** In json mode NO other output is allowed; in quiet mode only essentials. */
export function printMode(
  mode: ResolvedOutputMode,
  json: { payload: unknown } | null,
  quietLines: string[],
): void {
  if (mode.mode === 'json') {
    line(renderJsonDocument(json?.payload ?? {}));
    return;
  }
  if (mode.mode === 'quiet') {
    for (const entry of quietLines) line(entry);
    return;
  }
}
