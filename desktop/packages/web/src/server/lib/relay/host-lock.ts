// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host machine claim (doc 08 §3.12, `relay/host-lock.js`): all
 * instances sharing a data dir share the relay identity (serverId), so two
 * relay hosts would evict each other at the worker (4001 loop) and drop
 * paired devices onto a random instance. The claim is the file
 * `<data-dir>/relay-host.lock` = `{pid, claimedAt}`.
 *
 * Rules: `tryClaim` claims only when there is no live claimant
 * (`process.kill(pid, 0)`; ESRCH = stale ignored; EPERM = alive foreign
 * user, treated as alive); `forceClaim` is unconditional (explicit enable /
 * pairing creation); the displaced holder's watcher sees the takeover and
 * stands down. Reclaiming one's own live claim is a no-op refresh. Claim
 * WRITING failure logs a warning and behaves pre-lock (host starts; the
 * worker arbitrates).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';

export interface RelayHostClaim {
  pid: number;
  claimedAt: string;
}

/** Injectable liveness probe (tests fake dead/foreign pids). Default is the
 * doc's `process.kill(pid, 0)` semantics. */
export type ProcessAliveProbe = (pid: number) => boolean;

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseClaim(raw: unknown): RelayHostClaim | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (typeof doc.pid !== 'number' || !Number.isInteger(doc.pid) || doc.pid <= 0) return null;
  if (typeof doc.claimedAt !== 'string' || doc.claimedAt.length === 0) return null;
  return { pid: doc.pid, claimedAt: doc.claimedAt };
}

export interface RelayHostLockOptions {
  dataDir: string;
  processAlive?: ProcessAliveProbe;
}

/** Claim outcomes: `claimed` = the file holds our pid; `contended` = a LIVE
 * foreign claimant holds it (stand-by, never fight); `write-failed` =
 * §3.12 pre-lock posture — the claim could not be paged, so the HOST still
 * starts and the worker arbitrates (the caller must not read this as a
 * claim fight). */
export type RelayClaimOutcome = 'claimed' | 'contended' | 'write-failed';

export class RelayHostLock {
  private readonly dataDir: string;
  private readonly processAlive: ProcessAliveProbe;
  private lastWriteFailed = false;

  constructor(options: RelayHostLockOptions) {
    this.dataDir = options.dataDir;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
  }

  /** The live claim we observe: null when the file is absent/foreign-dead. */
  readClaim(): RelayHostClaim | null {
    const path = this.path();
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null; // corrupt lock behaves as no-claim (pre-lock posture)
    }
    return parseClaim(raw);
  }

  /** Our own current claim, or null (foreign / stale / absent). */
  readOwnClaim(): RelayHostClaim | null {
    const claim = this.readClaim();
    return claim !== null && claim.pid === process.pid ? claim : null;
  }

  /** True when the observed claim is live AND belongs to another process. */
  foreignClaimant(): RelayHostClaim | null {
    const claim = this.readClaim();
    return claim !== null && claim.pid !== process.pid && this.processAlive(claim.pid) ? claim : null;
  }

  /** Claim only when there is no live claimant; own live claim is a
   * no-op refresh. `contended` when a live foreign claimant holds it. */
  tryClaim(): RelayClaimOutcome {
    const claim = this.readClaim();
    if (claim !== null && claim.pid !== process.pid) {
      if (this.processAlive(claim.pid)) return 'contended';
      // ESRCH: stale claimable
    }
    return this.writeClaim();
  }

  /** Unconditional claim (explicit enable, pairing creation). */
  forceClaim(): RelayClaimOutcome {
    return this.writeClaim();
  }

  /** Deletes only the owner's own claim file. */
  release(): void {
    const claim = this.readClaim();
    if (claim === null || claim.pid !== process.pid) return;
    try {
      unlinkSync(this.path());
    } catch {
      // best-effort: a gone lock is a released lock
    }
  }

  path(): string {
    return joinPath(this.dataDir, 'relay-host.lock');
  }

  private writeClaim(): RelayClaimOutcome {
    const claimedAt = new Date().toISOString();
    const shape = { pid: process.pid, claimedAt };
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const path = this.path();
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(shape)}\n`, { encoding: 'utf8', mode: 0o644 });
      renameSync(tmp, path);
      this.lastWriteFailed = false;
      return 'claimed';
    } catch (error) {
      // §3.12: claim writing failure logs a warning and behaves pre-lock
      // (the host starts; the worker arbitrates). The warning dedupes per
      // failure STREAK and re-arms after any success.
      if (!this.lastWriteFailed) console.warn(`relay host claim write failed: ${String(error)}`);
      this.lastWriteFailed = true;
      return 'write-failed';
    }
  }
}
