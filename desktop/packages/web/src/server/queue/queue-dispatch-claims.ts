// SPDX-License-Identifier: Apache-2.0
/** Cross-process, per-session claim files prevent two runtimes from sending
 * the same durable queue head at once. Process death is recovered by PID
 * liveness checks; runtime disposal explicitly releases for restart replay. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface DispatchClaimDocument { pid: number; token: string; itemId: string; at: number }
export interface DispatchClaim { path: string; token: string; fd: number; release(): void }

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function readDispatchClaim(path: string): DispatchClaimDocument | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DispatchClaimDocument>;
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string'
        && typeof parsed.itemId === 'string' && typeof parsed.at === 'number') {
      if (processIsAlive(parsed.pid)) return parsed as DispatchClaimDocument;
      try { unlinkSync(path); } catch { /* another contender reclaimed it */ }
      return null;
    }
  } catch { /* a newly-created claim can be between open and write */ }
  try {
    if (Date.now() - statSync(path).mtimeMs > 5_000) unlinkSync(path);
  } catch { /* missing or inaccessible; the caller treats it as no claim */ }
  return null;
}

export class QueueDispatchClaims {
  private readonly claims = new Map<string, DispatchClaim>();

  constructor(private readonly queueFile: string, private readonly currentHeadId: (sessionId: string) => string | null) {}

  private pathFor(sessionId: string): string {
    const key = createHash('sha256').update(sessionId).digest('hex');
    return `${this.queueFile}.dispatch-${key}.claim`;
  }

  inFlightIdOf(sessionId: string, localSendingId: string | null): string | null {
    if (localSendingId) return localSendingId;
    const path = this.pathFor(sessionId);
    const claim = readDispatchClaim(path);
    if (claim) return claim.itemId;
    // During exclusive-create publication another process can observe the
    // file between open and write; conservatively pin the current head.
    return existsSync(path) ? this.currentHeadId(sessionId) : null;
  }

  acquire(sessionId: string, itemId: string): DispatchClaim | null {
    const path = this.pathFor(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    let fd: number;
    try { fd = openSync(path, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readDispatchClaim(path);
      if (existing) return null;
      // A dead/unreadable owner was reclaimed or disappeared; retry once.
      try { fd = openSync(path, 'wx'); }
      catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') return null;
        throw retryError;
      }
    }
    const token = randomUUID();
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, itemId, at: Date.now() } satisfies DispatchClaimDocument));
    } catch (error) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(path); } catch { /* cleanup only */ }
      throw error;
    }
    let released = false;
    return {
      path, token, fd,
      release(): void {
        if (released) return;
        released = true;
        const current = readDispatchClaim(path);
        if (current?.token === token) {
          try { unlinkSync(path); } catch { /* another owner reclaimed it */ }
        }
        try { closeSync(fd); } catch { /* already closed */ }
      },
    };
  }

  get(sessionId: string): DispatchClaim | null { return this.claims.get(sessionId) ?? null; }
  set(sessionId: string, claim: DispatchClaim): void { this.claims.set(sessionId, claim); }
  owns(sessionId: string, claim: DispatchClaim | null): boolean { return claim !== null && this.claims.get(sessionId) === claim; }

  release(sessionId: string, expected?: DispatchClaim): void {
    const current = this.claims.get(sessionId);
    if (current && (expected === undefined || current === expected)) {
      this.claims.delete(sessionId);
      current.release();
    } else if (expected) expected.release();
  }

  releaseAll(): void {
    for (const [sessionId, claim] of this.claims) this.release(sessionId, claim);
  }
}
