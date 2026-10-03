// SPDX-License-Identifier: Apache-2.0
import { runPrivateWindowsProgram } from './nnd-service-private-windows.js';

// Security: a missing PID is evidence only when the process query succeeds.
// Get-Process errors alone cannot distinguish an exit from denied inspection.
const PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.pid -isnot [int] -or $request.pid -lt 1) { throw 'invalid pid' }
    $first = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($request.pid)" -ErrorAction Stop)
    if ($first.Count -eq 0) {
        [Console]::Out.WriteLine('{"state":"absent"}')
        exit 0
    }
    if ($first.Count -ne 1) { throw 'ambiguous pid' }
    try {
        $started = (Get-Process -Id $request.pid -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()
        [Console]::Out.WriteLine((@{state='present'; start_id=$started} | ConvertTo-Json -Compress))
        exit 0
    } catch {
        # The target can exit between the two queries. Retry the observation
        # only when a second successful process query still sees this PID.
        $second = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($request.pid)" -ErrorAction Stop)
        if ($second.Count -eq 0) {
            [Console]::Out.WriteLine('{"state":"absent"}')
            exit 0
        }
        if ($second.Count -eq 1) {
            [Console]::Out.WriteLine('{"state":"retry"}')
            exit 0
        }
        throw 'ambiguous pid'
    }
} catch {
    [Console]::Out.WriteLine('{"state":"unknown"}')
}
`;

const MAX_PID = 2_147_483_647;
const START_ID = /^[1-9]\d{0,31}$/u;
const UNKNOWN = Object.freeze({ state: 'unknown' });
const SAME = Object.freeze({ state: 'same_process' });
const GONE = Object.freeze({ state: 'old_process_gone' });

function validRecorded(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 4 && value.version === 1 && value.platform === 'win32'
    && Number.isSafeInteger(value.pid) && value.pid >= 1 && value.pid <= MAX_PID
    && typeof value.start_id === 'string' && START_ID.test(value.start_id);
}

function nativeProbe(pid, signal) {
  return runPrivateWindowsProgram(PROGRAM, { pid }, signal);
}

/**
 * Observe the child recorded by private activation evidence. This observer
 * does not authorize admission, mutate evidence, or stop any process.
 */
export async function observeNndActivationChild(recorded, { signal, probe = nativeProbe } = {}) {
  if (!validRecorded(recorded) || typeof probe !== 'function' || signal?.aborted) return UNKNOWN;
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try { result = await probe(recorded.pid, signal); }
    catch { return UNKNOWN; }
    if (signal?.aborted || result === null || typeof result !== 'object' || Array.isArray(result)) return UNKNOWN;
    const keys = Object.keys(result);
    if (keys.length === 1 && keys[0] === 'state') {
      if (result.state === 'absent') return GONE;
      if (result.state === 'retry') continue;
      return UNKNOWN;
    }
    if (keys.length === 2 && result.state === 'present' && typeof result.start_id === 'string'
      && START_ID.test(result.start_id)) return result.start_id === recorded.start_id ? SAME : GONE;
    return UNKNOWN;
  }
  return UNKNOWN;
}
