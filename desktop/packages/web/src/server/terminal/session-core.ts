// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal session runtime (doc 07 sections 3-4, 7 Flow 1/6): session
 * registry with the exact create dedupe rules (existing running by
 * id/cwd/purpose, action adoption, pending single-flight, delete-while-
 * pending tombstone, 20-cap counting per C.2 #6), cleaned history
 * retention (512 KiB UTF-8-safe), theme answering injected into the PTY
 * (never published), synchronous attach barrier, restart chains keyed by
 * session id, close/force-kill/idle timings (1 s grace, 5 min sweep,
 * 30 min unattached idle; attached sessions NEVER reaped). Socket frame
 * intake follows section 3.3; unknown-session writes answer fatal
 * SESSION_NOT_FOUND. Shapes/validation split into records.ts and
 * create-validate.ts. Registered deltas: E-07-6/7/8/10/12 (NOTES/07).
 */
import { encodeFrame, decodeFrame, type ClientToServerFrame } from './protocol.ts';
import { createHistorySanitizer, utf8SafeTail, TERMINAL_HISTORY_MAX_BYTES } from './history.ts';
import { createThemeQuestionAnswerer } from './theme-response.ts';
import {
  buildCommandArgv, buildInteractiveArgv, buildPtyEnv, discoverShells, loginRequestSupported,
  normalizeShellPreference, resolvePosixPtyLaunch,
} from './shells.ts';
import {
  TerminalRequestError, actionKey, adoptResponse, assertCwdExists, assertIdentityMatches,
  assertForceKillScope, adoptableFlight, buildReplacement, flightMatchesScope, forceKillTargets,
  isReplacedActionRecord, normalizeDirectory, payloadOverCap, pendingMatches, publishTo,
  readAppearancePatch, resolvePlaceholder, resolveShellFor, validateCreate, writeQuietly,
  MAX_SESSIONS,
} from './create-validate.ts';
import type { PendingCreate, SessionRecord, SocketLike, ValidatedCreate } from './records.ts';
import type { CreateTerminalOptions, CreateTerminalResponse, TerminalAppearance, TerminalServerSession, TerminalShellId } from './types.ts';
import type { PtyEvents, PtyFactory, PtyHandle } from './pty-backend.ts';

export const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
export const SESSION_IDLE_AGE_MS = 30 * 60_000;
export const TERMINATION_GRACE_MS = 1_000;

export { TerminalRequestError, normalizeDirectory, MAX_SESSIONS, MAX_ID_LENGTH, MAX_PURPOSE_ID_LENGTH, MAX_COMMAND_LENGTH, DEFAULT_COLS, DEFAULT_ROWS } from './create-validate.ts';
export type { SocketLike, SessionRecord, PendingCreate } from './records.ts';

export class TerminalRuntime {
  private sessions = new Map<string, SessionRecord>();
  private pending = new Map<string, PendingCreate>();
  private pendingByAction = new Map<string, PendingCreate>();
  private restartChains = new Map<string, Promise<void>>();
  private sweep: NodeJS.Timeout | null = null;
  private readonly spawnPty: PtyFactory;
  private readonly now: () => number;
  readonly ptyBackend: string;

  constructor(spawnPty: PtyFactory, now: () => number = Date.now) {
    // Explicit fields: Node strip-only mode rejects parameter properties
    // (the server runs via `node src/server/index.ts`, erasable syntax).
    this.spawnPty = spawnPty;
    this.now = now;
    this.ptyBackend = process.platform === 'win32' ? 'conpty' : 'posix-pty';
  }

  shells(): { id: TerminalShellId; name: string; supportsLogin: boolean }[] {
    return discoverShells();
  }

  listSessions(): TerminalServerSession[] {
    return [...this.sessions.values()].map((session): TerminalServerSession => ({
      sessionId: session.id,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      mode: session.mode,
      purpose: session.purpose,
    })); // listings NEVER include command text (doc 07 section 3.7)
  }

  async createSession(options: CreateTerminalOptions): Promise<CreateTerminalResponse> {
    const request = validateCreate(options);
    const existing = this.sessions.get(request.id);
    if (existing !== undefined && existing.status === 'running') return this.adoptExisting(existing, request); // section C.2 #2-3
    if (existing !== undefined) assertIdentityMatches(existing, request); // exited id keeps the identity rule; a matching create REPLACES (E-07-7)
    const peer = this.findRunningActionPeer(request);
    if (peer !== null) return adoptResponse(peer); // action runs are adopted; identity travels in the response purpose
    const flight = this.findPendingFlight(request);
    if (flight !== null) return { ...(await flight.promise) }; // single-flight adoption
    this.assertSessionCap(request);
    return this.startFlight(request);
  }

  private adoptExisting(existing: SessionRecord, request: ValidatedCreate): CreateTerminalResponse {
    assertIdentityMatches(existing, request);
    return adoptResponse(existing);
  }

  private findRunningActionPeer(request: ValidatedCreate): SessionRecord | null {
    if (request.purpose.type !== 'project-action') return null;
    for (const session of this.sessions.values()) {
      if (session.status !== 'running') continue;
      if (request.cwd !== normalizeDirectory(session.cwd)) continue;
      const purpose = session.purpose;
      if (purpose.type === 'project-action' && purpose.actionId === request.purpose.actionId) return session;
    }
    return null;
  }

  private findPendingFlight(request: ValidatedCreate): PendingCreate | null {
    const byId = this.pending.get(request.id);
    if (byId !== undefined && adoptableFlight(byId) && pendingMatches(byId.options, request)) return byId;
    if (request.purpose.type !== 'project-action') return null;
    const byAction = this.pendingByAction.get(actionKey(request.cwd, request.purpose));
    return byAction !== undefined && adoptableFlight(byAction) ? byAction : null;
  }

  /** section C.2 #6: pending creates count; EXITED records to be replaced
   * by the incoming action run (same resolved cwd+actionId) do NOT, and
   * retire only AFTER the new PTY starts (failed create preserves the old
   * record's output). Exited plain records count: they stay attachable. */
  private assertSessionCap(request: ValidatedCreate): void {
    let live = 0;
    for (const session of this.sessions.values()) {
      if (session.status !== 'exited') {
        live += 1;
        continue;
      }
      if (!isReplacedActionRecord(session, request)) live += 1;
    }
    if (live + this.pending.size >= MAX_SESSIONS) throw new TerminalRequestError(429, 'terminal session cap reached');
  }

  private startFlight(request: ValidatedCreate): Promise<CreateTerminalResponse> {
    const entry: PendingCreate = { id: request.id, options: request.source, cancelled: false, settled: false, promise: resolvePlaceholder() };
    entry.promise = this.startCreate(request, entry);
    this.pending.set(request.id, entry);
    if (request.purpose.type === 'project-action') this.pendingByAction.set(actionKey(request.cwd, request.purpose), entry);
    return entry.promise.finally(() => this.clearFlight(entry, request));
  }

  /** Conditional delete: a same-id replacement flight may already sit in
   * the map, so an older settling flight must never erase the newer one. */
  private clearFlight(entry: PendingCreate, request: ValidatedCreate): void {
    if (this.pending.get(request.id) === entry) this.pending.delete(request.id);
    if (request.purpose.type !== 'project-action') return;
    const key = actionKey(request.cwd, request.purpose);
    if (this.pendingByAction.get(key) === entry) this.pendingByAction.delete(key);
  }

  private async startCreate(request: ValidatedCreate, entry: PendingCreate): Promise<CreateTerminalResponse> {
    await assertCwdExists(request.source.cwd); // real stat; missing -> recoverable TERMINAL_CWD_MISSING
    const resolved = resolveShellFor(request.shell);
    if (request.loginShell && !loginRequestSupported(resolved.id, process.platform === 'win32')) {
      throw new TerminalRequestError(400, `login shells are not supported for "${resolved.id}"`);
    }
    const argv = request.mode === 'command'
      ? buildCommandArgv(resolved.executable, resolved.id, request.loginShell, request.command!)
      : buildInteractiveArgv(resolved.executable, resolved.id, request.loginShell);
    const wrapped = resolvePosixPtyLaunch(argv[0]!, argv.slice(1));
    const pty = this.spawnPty({
      executable: wrapped.executable, args: wrapped.args, cwd: request.source.cwd,
      cols: request.cols, rows: request.rows, env: buildPtyEnv(request.appearance.themeMode !== 'light'),
    });
    if (entry.cancelled) {
      pty.kill(); // section C.2 #7: the delete won the race; the late PTY is terminated and never registered
      throw new TerminalRequestError(400, 'create cancelled before start');
    }
    const record = this.registerSession(request, resolved.id, pty);
    entry.settled = true; // recorded -> no longer adoptable by a fresh create
    this.retireReplacedActionRuns(request);
    return {
      sessionId: record.id, cols: record.cols, rows: record.rows,
      status: record.status, mode: record.mode, purpose: record.purpose,
    };
  }

  private registerSession(request: ValidatedCreate, shellId: Exclude<TerminalShellId, 'auto'>, pty: PtyHandle & PtyEvents): SessionRecord {
    const replaced = this.sessions.get(request.id);
    if (replaced !== undefined && replaced.status === 'exited') {
      this.publishFatal(replaced, 'SUPERSEDED'); // E-07-7: the exited viewer learns it was replaced, then re-attaches by id
    }
    const record: SessionRecord = {
      id: request.id,
      cwd: request.source.cwd,
      cols: request.cols,
      rows: request.rows,
      appearance: { ...request.appearance },
      mode: request.mode,
      command: request.command,
      purpose: request.purpose,
      shellId,
      loginShell: request.loginShell,
      status: 'running',
      sequence: 0,
      history: '',
      lastActivity: this.now(),
      pty,
      historyTrimmer: createHistorySanitizer(),
      themeAnswerer: createThemeQuestionAnswerer(request.appearance),
      attached: new Set(),
      createdAt: this.now(),
    };
    this.sessions.set(record.id, record);
    pty.onData((data) => this.emitOutput(record, data)); // listeners wired in the SAME turn as spawn (doc invariant 2)
    pty.onExit((event) => this.onPtyExit(record, event));
    return record;
  }

  /** section C.2 #6: exited action records for the same resolved cwd+action
   * retire AFTER the new PTY starts; their viewers learn it is superseded. */
  private retireReplacedActionRuns(request: ValidatedCreate): void {
    if (request.purpose.type !== 'project-action') return;
    for (const session of [...this.sessions.values()]) {
      if (session.id === request.id || session.status !== 'exited') continue;
      if (!isReplacedActionRecord(session, request)) continue;
      this.publishFatal(session, 'SUPERSEDED');
      this.sessions.delete(session.id);
    }
  }

  private emitOutput(record: SessionRecord, data: string): void {
    if (this.sessions.get(record.id) !== record || record.pty === null) return; // closed/killed record: silence late bytes
    if (data.length === 0) return;
    record.lastActivity = this.now(); // output moves lastActivity; attach/resize never do (section C.5)
    const scan = record.themeAnswerer.push(data);
    if (scan.replies.length > 0) writeQuietly(record, scan.replies); // answers ride straight into the PTY
    const clean = record.historyTrimmer.push(scan.clean); // trailing partial stays pending for the next chunk
    record.history = utf8SafeTail(record.history + clean, TERMINAL_HISTORY_MAX_BYTES);
    record.sequence += 1;
    const frame = scan.clean === data
      ? { v: 3 as const, t: 'output' as const, s: record.id, q: record.sequence, d: data }
      : { v: 3 as const, t: 'output' as const, s: record.id, q: record.sequence, d: data, r: scan.clean };
    publishTo(record, encodeFrame(frame));
  }

  private onPtyExit(record: SessionRecord, event: { exitCode?: number; signal?: number }): void {
    if (this.sessions.get(record.id) !== record || record.status !== 'running') return; // killed/replaced records already published their frame
    record.status = 'exited';
    record.exitCode = event.exitCode;
    record.signal = event.signal;
    record.lastActivity = this.now();
    record.sequence += 1;
    publishTo(record, encodeFrame({
      v: 3, t: 'exit', s: record.id, q: record.sequence, exitCode: event.exitCode, signal: event.signal,
    }));
  }

  write(sessionId: string, data: string): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new TerminalRequestError(404, 'session not found');
    if (record.status !== 'running' || record.pty === null) {
      publishTo(record, encodeFrame({ v: 3, t: 'error', s: sessionId, code: 'NOT_RUNNING', fatal: false }));
      return;
    }
    try {
      record.pty.write(data);
      record.lastActivity = this.now(); // writes refresh activity (section C.5)
    } catch {
      publishTo(record, encodeFrame({ v: 3, t: 'error', s: sessionId, code: 'WRITE_FAILED', fatal: false }));
    }
  }

  resize(sessionId: string, cols: number, rows: number): { success: boolean; cols: number; rows: number } {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 1000 || rows < 1 || rows > 500) {
      throw new TerminalRequestError(400, 'invalid size');
    }
    const record = this.requireSession(sessionId);
    record.cols = cols;
    record.rows = rows;
    if (record.status === 'running') record.pty?.resize(cols, rows); // exited sessions just record the size
    return { success: true, cols, rows };
  }

  updateAppearance(sessionId: string, appearance: TerminalAppearance): { success: boolean } {
    const patch = readAppearancePatch(appearance);
    const record = this.requireSession(sessionId);
    record.appearance = {
      themeMode: patch.themeMode ?? record.appearance.themeMode,
      terminalBackground: patch.terminalBackground ?? record.appearance.terminalBackground,
      terminalForeground: patch.terminalForeground ?? record.appearance.terminalForeground,
    };
    if (patch.themeMode !== undefined && record.themeAnswerer.mode2031()) {
      writeQuietly(record, record.themeAnswerer.themeNotify(patch.themeMode)); // 2031 subscribers recolor (section 4.6)
    }
    return { success: true };
  }

  /** Per-session serialized chain KEYED BY ID: a queued restart re-resolves
   * the CURRENT record, so a restart queued behind a completed one still
   * targets the live session (section 4.7). */
  restart(sessionId: string, options: Partial<CreateTerminalOptions>): Promise<CreateTerminalResponse> {
    this.requireSession(sessionId);
    if (options.loginShell !== undefined && typeof options.loginShell !== 'boolean') throw new TerminalRequestError(400, 'invalid loginShell');
    const chain = this.restartChains.get(sessionId) ?? Promise.resolve();
    const queued = chain.then(() => this.performRestart(sessionId, options));
    const head = queued.then((): void => undefined, (): void => undefined);
    this.restartChains.set(sessionId, head);
    head.finally(() => {
      if (this.restartChains.get(sessionId) === head) this.restartChains.delete(sessionId);
    });
    return queued;
  }

  private async performRestart(sessionId: string, options: Partial<CreateTerminalOptions>): Promise<CreateTerminalResponse> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new TerminalRequestError(404, 'session closed before restart');
    if (record.mode === 'command') throw new TerminalRequestError(400, 'command sessions cannot restart'); // no stale action metadata shells
    const shellPref = normalizeShellPreference(options.shell ?? 'auto');
    if (shellPref === null) throw new TerminalRequestError(400, 'unknown shell preference');
    const resolved = resolveShellFor(shellPref);
    const loginShell = options.loginShell ?? record.loginShell;
    const argv = buildInteractiveArgv(resolved.executable, resolved.id, loginShell && loginRequestSupported(resolved.id, process.platform === 'win32'));
    const wrapped = resolvePosixPtyLaunch(argv[0]!, argv.slice(1));
    const replacement = this.spawnPty({
      executable: wrapped.executable, args: wrapped.args, cwd: record.cwd, cols: record.cols, rows: record.rows,
      env: buildPtyEnv(record.appearance.themeMode !== 'light'),
    });
    const replacementRecord = buildReplacement(record, resolved.id, loginShell, replacement, this.now());
    this.sessions.set(record.id, replacementRecord); // replacement wired BEFORE the old process dies
    replacement.onData((data) => this.emitOutput(replacementRecord, data));
    replacement.onExit((event) => this.onPtyExit(replacementRecord, event));
    const prior = record.pty;
    if (prior !== null) this.terminateProcess(prior); // old process terminated AFTER the replacement is live
    record.sequence += 1;
    replacementRecord.sequence = record.sequence; // restarted increments the session sequence by 1 per section 3.4
    publishTo(replacementRecord, encodeFrame({ v: 3, t: 'restarted', s: record.id, q: replacementRecord.sequence, history: '' }));
    return {
      sessionId: record.id, cols: replacementRecord.cols, rows: replacementRecord.rows,
      status: 'running', mode: 'interactive', purpose: replacementRecord.purpose,
    };
  }

  close(sessionId: string): { success: boolean } {
    const pending = this.pending.get(sessionId);
    if (pending !== undefined && !pending.settled) {
      pending.cancelled = true; // tombstone: the late PTY is terminated on arrival (section C.2 #7)
      return { success: true };
    }
    const record = this.sessions.get(sessionId);
    if (record === undefined) return { success: true }; // delete is idempotent for the client
    this.publishFatal(record, 'CLOSED');
    this.terminateSession(record);
    return { success: true };
  }

  forceKill(scope: { sessionId?: string; cwd?: string }): { success: boolean; killedCount: number; killedSessionIds: string[] } {
    assertForceKillScope(scope);
    const targets = forceKillTargets(this.sessions, scope);
    for (const record of targets) {
      this.publishFatal(record, 'KILLED');
      if (record.pty !== null) this.terminateProcess(record.pty); // immediate SIGKILL, no grace
      this.sessions.delete(record.id);
    }
    for (const flight of this.pending.values()) {
      if (flightMatchesScope(flight, scope)) flight.cancelled = true; // a late PTY must not register after a kill
    }
    return { success: true, killedCount: targets.length, killedSessionIds: targets.map((record) => record.id) };
  }

  touch(sessionIds: string[]): { touched: number } {
    let touched = 0;
    for (const id of sessionIds) {
      const record = this.sessions.get(id);
      // A project can be unmounted when its PTY exits, leaving the client's
      // tab marked running until it is observed again. Do not let that stale
      // keepalive preserve an exited, cap-counting record forever.
      if (record === undefined || record.status !== 'running') continue;
      record.lastActivity = this.now(); // background tabs fight the idle reaper with keepalives
      touched += 1;
    }
    return { touched };
  }

  startSweep(): void {
    if (this.sweep !== null) return;
    this.sweep = setInterval(() => this.sweepOnce(), IDLE_SWEEP_INTERVAL_MS);
  }

  private sweepOnce(): void {
    const cutoff = this.now() - SESSION_IDLE_AGE_MS;
    for (const record of [...this.sessions.values()]) {
      if (record.attached.size > 0) continue; // attached sessions are NEVER idle (doc invariant 7)
      if (record.lastActivity > cutoff) continue;
      this.publishFatal(record, 'IDLE_TIMEOUT');
      this.terminateSession(record);
    }
  }

  dispose(): void {
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
    for (const pending of this.pending.values()) pending.cancelled = true; // late spawns terminate and reject (tombstone rule)
    for (const record of [...this.sessions.values()]) {
      this.publishFatal(record, 'KILLED');
      if (record.pty !== null) this.terminateProcess(record.pty);
      this.sessions.delete(record.id);
    }
    this.pending.clear();
    this.pendingByAction.clear();
    this.restartChains.clear();
  }

  /** Dead-socket bookkeeping (E-07-12): the WS layer calls this on close/
   * error so a held attachment cannot block the idle reaper forever. */
  detachSocket(socket: SocketLike): void {
    for (const record of this.sessions.values()) record.attached.delete(socket);
  }

  /** section 3.3 socket intake. The attach barrier (register + snapshot)
   * runs in ONE synchronous turn; PTY emits happen only in async callbacks,
   * so no event can slip between snapshot capture and delivery. */
  handleSocketFrame(socket: SocketLike, data: unknown): { unknownSessionError?: Buffer } {
    if (payloadOverCap(data)) return this.rejectFrame(socket);
    const decoded = decodeFrame(data);
    if (!decoded.ok) return this.rejectFrame(socket);
    const frame: ClientToServerFrame = decoded.frame;
    switch (frame.t) {
      case 'hello':
        socket.send(encodeFrame({ v: 3, t: 'hello' }));
        return {};
      case 'ping':
        socket.send(encodeFrame({ v: 3, t: 'pong' }));
        return {};
      case 'attach':
        return this.handleAttach(socket, frame.s);
      case 'detach': {
        const held = this.sessions.get(frame.s);
        held?.attached.delete(socket);
        return {};
      }
      case 'write': {
        const record = this.sessions.get(frame.s);
        if (record === undefined) return { unknownSessionError: encodeFrame({ v: 3, t: 'error', s: frame.s, code: 'SESSION_NOT_FOUND', fatal: true }) };
        this.write(record.id, frame.d);
        return {};
      }
      default:
        return {};
    }
  }

  private rejectFrame(socket: SocketLike): { unknownSessionError?: Buffer } {
    socket.send(encodeFrame({ v: 3, t: 'error', code: 'BAD_FRAME', fatal: false }));
    return {};
  }

  private handleAttach(socket: SocketLike, sessionId: string): { unknownSessionError?: Buffer } {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return { unknownSessionError: encodeFrame({ v: 3, t: 'error', s: sessionId, code: 'SESSION_NOT_FOUND', fatal: true }) };
    record.attached.add(socket); // attach is idempotent per socket (section 3.3); a re-snapshot is inert behind q-dedupe
    socket.send(encodeFrame({
      v: 3, t: 'snapshot', s: record.id, q: record.sequence, history: record.history,
      cols: record.cols, rows: record.rows, status: record.status, exitCode: record.exitCode, signal: record.signal,
      mode: record.mode, purpose: record.purpose, runtime: 'node', ptyBackend: this.ptyBackend,
    }));
    return {};
  }

  private publishFatal(record: SessionRecord, code: 'CLOSED' | 'KILLED' | 'IDLE_TIMEOUT' | 'SUPERSEDED'): void {
    publishTo(record, encodeFrame({ v: 3, t: 'error', s: record.id, code, fatal: true }));
  }

  private terminateSession(record: SessionRecord): void {
    const dying = record.pty;
    if (dying !== null) this.terminateProcess(dying);
    record.pty = null;
    this.sessions.delete(record.id);
  }

  /** section 4.7: SIGTERM with 1 s escalation; POSIX targets the process
   * GROUP (-pid) so grandchildren die with the session; Windows relies on
   * the ConPTY close anchor. */
  private terminateProcess(pty: PtyHandle): void {
    if (process.platform === 'win32') {
      try { pty.kill(); } catch { /* ConPTY already closed */ }
      return;
    }
    try { process.kill(-pty.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
      try { process.kill(-pty.pid, 'SIGKILL'); } catch { try { pty.kill(); } catch { /* goodbye */ } }
    }, TERMINATION_GRACE_MS).unref();
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new TerminalRequestError(404, 'session not found');
    return record;
  }
}
