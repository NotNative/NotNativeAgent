// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal create validation + registry helpers (doc 07 sections 3.7/4.1/
 * 4.2/9 and C.2): ids <= 128, dims 1..1000 x 1..500, purpose ids <= 128
 * AFTER trim, command cap 65536, strict appearance scalars (colors <= 128
 * chars - E-07-11), real cwd stat with the ONE recoverable code
 * TERMINAL_CWD_MISSING. No command escaping by design (section 9).
 */
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TERMINAL_WS_MAX_PAYLOAD_BYTES } from './protocol.ts';
import { createHistorySanitizer } from './history.ts';
import { createThemeQuestionAnswerer } from './theme-response.ts';
import { normalizeShellPreference, resolveAutoShell, resolveExplicitShell } from './shells.ts';
import type {
  CreateTerminalOptions, CreateTerminalResponse, TerminalAppearance,
  TerminalMode, TerminalPurpose, TerminalShellId,
} from './types.ts';
import type { PendingCreate, SessionRecord, TerminalResolvedAppearance, ValidatedCreate } from './records.ts';
import type { PtyEvents, PtyHandle } from './pty-backend.ts';

export const MAX_SESSIONS = 20;
export const MAX_ID_LENGTH = 128;
export const MAX_PURPOSE_ID_LENGTH = 128;
export const MAX_COMMAND_LENGTH = 65_536;
export const MAX_COLOR_LENGTH = 128;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export class TerminalRequestError extends Error {
  readonly status: number;
  readonly payload: { error: string; code?: string };

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.payload = { error: message, ...(code !== undefined ? { code } : {}) };
  }
}

export function validateCreate(options: CreateTerminalOptions): ValidatedCreate {
  const id = options.sessionId ?? randomUUID();
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) throw new TerminalRequestError(400, 'invalid session id');
  if (typeof options.cwd !== 'string' || options.cwd.trim().length === 0) throw new TerminalRequestError(400, 'cwd is required');
  const mode: TerminalMode = options.mode ?? 'interactive';
  if (mode !== 'interactive' && mode !== 'command') throw new TerminalRequestError(400, 'invalid mode');
  const command = mode === 'command' ? requireCommand(options.command) : null;
  const shell = readShell(options.shell);
  const purpose = readPurpose(options.purpose);
  return buildValidated(options, id, mode, command, shell, purpose);
}

function requireCommand(command: unknown): string {
  if (typeof command !== 'string' || command.trim().length === 0) throw new TerminalRequestError(400, 'command is required for command mode');
  if (command.length > MAX_COMMAND_LENGTH) throw new TerminalRequestError(400, 'command too long');
  return command;
}

function readShell(shell: unknown): TerminalShellId | undefined {
  if (shell === undefined) return undefined;
  const normalized = normalizeShellPreference(String(shell));
  if (normalized === null) throw new TerminalRequestError(400, 'unknown shell id');
  return normalized;
}

/** Tolerant: anything without a project-action marker is a plain terminal. */
function readPurpose(purpose: unknown): TerminalPurpose {
  if (typeof purpose !== 'object' || purpose === null || (purpose as { type?: unknown }).type !== 'project-action') return { type: 'terminal' };
  const actionId = trimmedId((purpose as { actionId?: unknown }).actionId);
  const executionId = trimmedId((purpose as { executionId?: unknown }).executionId);
  if (actionId === null || executionId === null) throw new TerminalRequestError(400, 'invalid project-action purpose');
  return { type: 'project-action', actionId, executionId };
}

/** section 4.1: purpose ids are capped at 128 chars AFTER trim. */
function trimmedId(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 && text.length <= MAX_PURPOSE_ID_LENGTH ? text : null;
}

function buildValidated(options: CreateTerminalOptions, id: string, mode: TerminalMode, command: string | null, shell: TerminalShellId | undefined, purpose: TerminalPurpose): ValidatedCreate {
  const cols = options.cols ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 1000 || rows < 1 || rows > 500) throw new TerminalRequestError(400, 'invalid size');
  if (options.loginShell !== undefined && typeof options.loginShell !== 'boolean') throw new TerminalRequestError(400, 'invalid loginShell');
  return {
    id,
    cwd: normalizeDirectory(options.cwd),
    cols,
    rows,
    mode,
    command,
    purpose,
    shell,
    loginShell: options.loginShell ?? false,
    appearance: readAppearance(options),
    source: { ...options, purpose },
  };
}

function readAppearance(options: CreateTerminalOptions): TerminalResolvedAppearance {
  if (options.themeMode !== undefined && options.themeMode !== 'light' && options.themeMode !== 'dark') {
    throw new TerminalRequestError(400, 'themeMode must be light or dark');
  }
  return {
    themeMode: options.themeMode ?? 'dark',
    terminalBackground: boundedColor(options.terminalBackground, 'terminalBackground'),
    terminalForeground: boundedColor(options.terminalForeground, 'terminalForeground'),
  };
}

/** E-07-11: appearance scalars ride create/appearance exactly, strictly
 * typed; color strings are bounded so stored values can never inflate the
 * OSC query replies written back into the PTY. */
export function readAppearancePatch(appearance: TerminalAppearance): TerminalAppearance {
  if (typeof appearance !== 'object' || appearance === null || Array.isArray(appearance)) throw new TerminalRequestError(400, 'invalid appearance');
  if (appearance.themeMode !== undefined && appearance.themeMode !== 'light' && appearance.themeMode !== 'dark') throw new TerminalRequestError(400, 'themeMode must be light or dark');
  return {
    themeMode: appearance.themeMode,
    terminalBackground: boundedColor(appearance.terminalBackground, 'terminalBackground'),
    terminalForeground: boundedColor(appearance.terminalForeground, 'terminalForeground'),
  };
}

function boundedColor(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TerminalRequestError(400, `${field} must be a CSS color string`);
  if (value.length > MAX_COLOR_LENGTH) throw new TerminalRequestError(400, `${field} too long`);
  return value;
}

export async function assertCwdExists(cwd: string): Promise<void> {
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new TerminalRequestError(400, `cwd does not exist: ${cwd}`, 'TERMINAL_CWD_MISSING');
    }
    throw new TerminalRequestError(400, `cwd is not usable: ${cwd}`);
  }
}

/** Identity rule (section 4.1): an existing id cannot be reused for
 * another cwd or purpose; plain terminals also fix mode+command. */
export function assertIdentityMatches(existing: SessionRecord, request: ValidatedCreate): void {
  if (normalizeDirectory(existing.cwd) !== request.cwd) throw new TerminalRequestError(400, 'session id already used for another cwd');
  if (!samePurpose(existing.purpose, request.purpose)) throw new TerminalRequestError(400, 'session id already used for another purpose');
  if (request.purpose.type !== 'project-action' && (existing.mode !== request.mode || existing.command !== request.command)) {
    throw new TerminalRequestError(400, 'session id already used with another command');
  }
}

export function samePurpose(left: TerminalPurpose, right: TerminalPurpose): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'terminal') return true;
  const other = right as { actionId: string; executionId: string };
  return left.actionId === other.actionId && left.executionId === other.executionId;
}

export function actionKey(cwd: string, purpose: TerminalPurpose): string {
  return purpose.type === 'project-action' ? `${normalizeDirectory(cwd)}\u0000${purpose.actionId}` : normalizeDirectory(cwd);
}

/** section C.2 #4-5: plain flights match on cwd/shell/login/mode/command
 * (never dims - a remount resize overlapping the spawn is deliberate);
 * action flights match on cwd+actionId only. Cwd normalization keeps a
 * same-directory re-spell (\\ vs /, trailing slash) single-flighted. */
export function pendingMatches(options: CreateTerminalOptions, request: ValidatedCreate): boolean {
  return normalizeDirectory(options.cwd ?? '') === request.cwd
    && normalizeShellPreferenceSafe(options.shell) === request.shell
    && (options.loginShell ?? false) === request.loginShell
    && (options.mode ?? 'interactive') === request.mode
    && (options.command ?? null) === request.command;
}

export function normalizeShellPreferenceSafe(shell: CreateTerminalOptions['shell']): TerminalShellId | undefined {
  return shell === undefined ? undefined : normalizeShellPreference(String(shell)) ?? undefined;
}

export function adoptResponse(record: SessionRecord): CreateTerminalResponse {
  return { sessionId: record.id, cols: record.cols, rows: record.rows, status: record.status, mode: record.mode, purpose: record.purpose };
}

/** Placeholder only satisfies the awaited promise shape; every real flight
 * reassigns entry.promise before the record of the first caller resolves. */
export function resolvePlaceholder(): Promise<CreateTerminalResponse> {
  return Promise.resolve({ sessionId: '', cols: DEFAULT_COLS, rows: DEFAULT_ROWS, status: 'running', mode: 'interactive', purpose: { type: 'terminal' } });
}

/** section C.2 #6: an EXITED record whose (resolved cwd, actionId) matches
 * the incoming action create is the record a new run is about to replace:
 * it does NOT count toward the cap and retires only after the new PTY
 * starts (a failed create preserves the old record and its output). */
export function isReplacedActionRecord(session: SessionRecord, request: ValidatedCreate): boolean {
  if (session.status !== 'exited') return false;
  if (request.purpose.type !== 'project-action') return false;
  const purpose = session.purpose;
  return purpose.type === 'project-action' && purpose.actionId === request.purpose.actionId && normalizeDirectory(session.cwd) === request.cwd;
}

export function payloadOverCap(data: unknown): boolean {
  const bytes = data instanceof Uint8Array ? data : (Buffer.isBuffer(data) ? data : null);
  return bytes !== null && bytes.length > TERMINAL_WS_MAX_PAYLOAD_BYTES;
}

export function forceKillTargets(sessions: Map<string, SessionRecord>, scope: { sessionId?: string; cwd?: string }): SessionRecord[] {
  if (scope.sessionId !== undefined) {
    const found = sessions.get(scope.sessionId);
    return found !== undefined ? [found] : [];
  }
  const needle = normalizeDirectory(scope.cwd ?? '');
  return [...sessions.values()].filter((session) => normalizeDirectory(session.cwd) === needle);
}

/** section 3.7 envelope: force-kill needs at least one targeting field. */
export function assertForceKillScope(scope: { sessionId?: unknown; cwd?: unknown }): void {
  if (typeof scope.sessionId !== 'string' && typeof scope.cwd !== 'string') {
    throw new TerminalRequestError(400, 'force-kill requires sessionId or cwd');
  }
}

/** In-flight creates are tombstoned too: a kill-by-cwd (or -id) must never
 * let the late PTY register afterward (doc invariant 1, no zombie PTYs). */
export function flightMatchesScope(flight: PendingCreate, scope: { sessionId?: string; cwd?: string }): boolean {
  if (scope.sessionId !== undefined) return flight.id === scope.sessionId;
  return normalizeDirectory(flight.options.cwd ?? '') === normalizeDirectory(scope.cwd ?? '');
}

export function normalizeDirectory(directory: string): string {
  const cleaned = String(directory).trim().replaceAll('\\', '/');
  return cleaned.length > 1 ? cleaned.replace(/\/+$/u, '') : cleaned;
}

// ---------- registry emission helpers ----------

export function adoptableFlight(flight: PendingCreate): boolean {
  return !flight.cancelled && !flight.settled; // tombstoned or settled flights are never adopted
}

export function publishTo(record: SessionRecord, frame: Buffer): void {
  for (const socket of record.attached) socket.send(frame);
}

export function writeQuietly(record: SessionRecord, data: string): void {
  try { record.pty?.write(data); } catch { /* the PTY may have already exited */ }
}

/** section 4.7 restart replacement: same identity, fresh sanitizers, empty
 * history; the attachment Set is inherited by reference so viewers keep
 * receiving. The band sequence is patched by the caller (q increments). */
export function buildReplacement(record: SessionRecord, shellId: Exclude<TerminalShellId, 'auto'>, loginShell: boolean, pty: PtyHandle & PtyEvents, now: number): SessionRecord {
  return {
    ...record,
    pty,
    status: 'running',
    exitCode: undefined,
    signal: undefined,
    history: '',
    lastActivity: now,
    historyTrimmer: createHistorySanitizer(),
    themeAnswerer: createThemeQuestionAnswerer(record.appearance),
    shellId,
    loginShell,
  };
}

/** section 4.4: auto chains or a strict explicit id; an unavailable
 * explicit preference FAILS loudly (never silently substituted). */
export function resolveShellFor(preference: TerminalShellId | undefined): { executable: string; id: Exclude<TerminalShellId, 'auto'> } {
  if (preference === 'auto' || preference === undefined) {
    const resolved = resolveAutoShell();
    if (resolved === null) throw new TerminalRequestError(400, 'no available shell found');
    return resolved;
  }
  const resolved = resolveExplicitShell(preference);
  if (resolved === null) throw new TerminalRequestError(400, `Terminal shell "${preference}" is not available`);
  return resolved;
}
