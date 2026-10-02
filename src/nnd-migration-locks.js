// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { SessionLock, inspectSessionLock } from './persistence/session-lock.js';
import { ProcessIdentity } from './reliability/process-identity.js';
import { runPrivateWindowsProgram } from './nnd-service-private-windows.js';
import { ContractError } from './ids.js';

const PROBE = String.raw`$ErrorActionPreference='Stop'
$r=[Console]::In.ReadToEnd()|ConvertFrom-Json
if($r.pid -isnot [int] -or $r.pid -lt 1) { throw 'invalid' }
$started=(Get-Process -Id $r.pid -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()
[Console]::Out.WriteLine((@{started=$started}|ConvertTo-Json -Compress))`;
const identity = new ProcessIdentity({ runProbe: async (_command, args) => {
  const match = /Get-Process -Id ([1-9][0-9]*) /u.exec(args.at(-1));
  if (!match) throw new Error('Unsupported process probe');
  return (await runPrivateWindowsProgram(PROBE, { pid: Number(match[1]) })).started;
} });
export async function acquireMigrationSessionLocks(paths, ids, signal) {
  const locks = [];
  try {
    for (const id of [...ids].sort()) {
      signal.throwIfAborted();
      const state = await inspectSessionLock(join(paths.sessions, `${id}.lock`), { processIdentity: identity });
      if (!['missing', 'dead', 'different'].includes(state.status)) {
        throw new ContractError('nnd_migration_locked', 'NND migration requires every catalog session to be stopped and verifiable.');
      }
      const lock = new SessionLock(paths.sessions, id, { processIdentity: identity, strictPriorOwner: true });
      await lock.acquire(); locks.push(lock);
    }
    return () => releaseLocks(locks);
  } catch (error) {
    try { await releaseLocks(locks); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Migration lock cleanup failed'); }
    throw error;
  }
}
async function releaseLocks(locks) {
  const results = await Promise.allSettled(locks.map((lock) => lock.release()));
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Migration session locks could not all be released');
}
