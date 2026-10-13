// SPDX-License-Identifier: Apache-2.0
/**
 * Shared process-output mechanics for the tunnel starters (doc 08 §4.3):
 * a bounded text sink (byte-capped; cloudflared managed-remote stdout is
 * drained WITHOUT logging per §12.1) and `waitForTunnelReadiness` — resolve
 * on a ready pattern, reject on a fatal pattern, child exit/error, or the
 * hard output timeout; a successful line at any time BEFORE that is
 * "any output was seen", which arms the shortened liveness fallback that
 * additionally resolves the wait (URLs for managed modes do not depend on
 * process wording, so the first output proves the child is alive).
 */
import type { TunnelChildLike } from './tunnel-spawn.ts';

export const SINK_MAX_CHARS = 512 * 1024;

export class TunnelOutputSink {
  private text = '';

  /** Returns the accumulated text (capped). */
  append(chunk: Buffer | string): string {
    this.text = (this.text + (typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    if (this.text.length > SINK_MAX_CHARS) this.text = this.text.slice(this.text.length - SINK_MAX_CHARS);
    return this.text;
  }

  snapshot(): string {
    return this.text;
  }

  lines(): string[] {
    return this.text.split('\n').filter((line) => line.trim() !== '');
  }
}

export type ReadinessOutcome =
  | { kind: 'ready'; fromLine: string }
  | { kind: 'liveness'; lastLine: string };

export type ReadinessFailure =
  | { kind: 'fatal'; reason: string }
  | { kind: 'exit'; code: number | null; signal: string | null }
  | { kind: 'error'; error: Error }
  | { kind: 'timeout' };

export interface ReadinessOptions {
  readyPatterns: readonly RegExp[];
  fatalPatterns: readonly RegExp[];
  /** Hard cap: no output and no match ⇒ rejected (20 s managed contract). */
  outputTimeoutMs: number;
  /** When ANY output arrived, this shortened timer also resolves the wait
   * successfully (6 s managed contract). */
  livenessFallbackMs: number;
  now?: () => number;
}

export interface ReadinessWait {
  promise: Promise<ReadinessOutcome>;
  cancel: () => void;
}

interface ReadinessState {
  settled: boolean;
  rejectReason: string | null;
  sawOutput: boolean;
  lastLine: string;
  timers: ReturnType<typeof setTimeout>[];
  sink: TunnelOutputSink;
  resolveWait: (outcome: ReadinessOutcome) => void;
  rejectWait: (outcome: ReadinessFailure) => void;
}

/** Wires the child's pipes + exit/error to the readiness promise. The
 * caller stays owner of kill()/cleanup; this wait never kills. */
export function waitForTunnelReadiness(child: TunnelChildLike, options: ReadinessOptions): ReadinessWait {
  let resolveWait!: (outcome: ReadinessOutcome) => void;
  let rejectWait!: (outcome: ReadinessFailure) => void;
  const promise = new Promise<ReadinessOutcome>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject as (outcome: ReadinessFailure) => void;
  });
  const state: ReadinessState = {
    settled: false,
    rejectReason: null,
    sawOutput: false,
    lastLine: '',
    timers: [],
    sink: new TunnelOutputSink(),
    resolveWait,
    rejectWait,
  };
  child.on('exit', (code, signal) => finishReject(state, { kind: 'exit', code, signal }));
  child.on('error', (error) => finishReject(state, { kind: 'error', error }));
  state.timers.push(setTimeout(() => finishReject(state, { kind: 'timeout' }), Math.max(0, options.outputTimeoutMs)));
  const onChunk = (chunk: Buffer | string): void => {
    const text = state.sink.append(chunk);
    state.lastLine = state.sink.lines().slice(-1)[0] ?? '';
    armLiveness(state, options);
    evaluate(state, options, text);
  };
  attachStream(child.stdout, onChunk);
  attachStream(child.stderr, onChunk); // stderr participates in matching; managed-*-specific mirroring is the caller's job
  return {
    promise,
    cancel: (): void => {
      state.settled = true;
      clearTimers(state.timers);
    },
  };
}

function finishResolve(state: ReadinessState, outcome: ReadinessOutcome): void {
  if (state.settled) return;
  state.settled = true;
  clearTimers(state.timers);
  state.resolveWait(outcome);
}

function finishReject(state: ReadinessState, outcome: ReadinessFailure): void {
  if (state.settled) return;
  state.settled = true;
  state.rejectReason = outcome.kind === 'fatal'
    ? outcome.reason
    : outcome.kind === 'exit'
      ? `child exited (code ${String(outcome.code)}, signal ${String(outcome.signal)})`
      : outcome.kind === 'error'
        ? `child error: ${outcome.error.message}`
        : 'no output within the readiness window';
  clearTimers(state.timers);
  state.rejectWait(outcome);
}

function evaluate(state: ReadinessState, options: ReadinessOptions, text: string): void {
  for (const pattern of options.fatalPatterns) {
    const match = text.match(pattern);
    if (match !== null) {
      finishReject(state, { kind: 'fatal', reason: match[0] });
      return;
    }
  }
  for (const pattern of options.readyPatterns) {
    const match = text.match(pattern);
    if (match !== null) {
      finishResolve(state, { kind: 'ready', fromLine: lastLineOf(state.sink, match) });
      return;
    }
  }
}

function armLiveness(state: ReadinessState, options: ReadinessOptions): void {
  if (state.sawOutput) return;
  state.sawOutput = true;
  state.timers.push(setTimeout(() => finishResolve(state, { kind: 'liveness', lastLine: state.lastLine }), Math.max(0, options.livenessFallbackMs)));
}

function attachStream(stream: TunnelChildLike['stdout'] | TunnelChildLike['stderr'], listener: (chunk: Buffer | string) => void): void {
  stream?.on('data', listener);
}

function clearTimers(timers: ReturnType<typeof setTimeout>[]): void {
  for (const timer of timers) clearTimeout(timer);
}

function lastLineOf(sink: TunnelOutputSink, match: RegExpMatchArray): string {
  const upTo = match.index ?? 0;
  const segment = sink.snapshot().slice(0, upTo);
  const lines = segment.split('\n').filter((line) => line.trim() !== '');
  return lines[lines.length - 1] ?? match[0];
}
