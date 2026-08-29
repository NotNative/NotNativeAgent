// SPDX-License-Identifier: Apache-2.0

const POWERSHELL_OBSERVATION_COMMANDS = new Set([
  'format-list', 'format-table', 'get-childitem', 'measure-object', 'out-null',
  'select-object', 'sort-object',
]);

export function shellObservationPurpose(script, shell) {
  return ['powershell', 'pwsh'].includes(shell) && powershellFilesystemObservation(script)
    ? 'filesystem_observation' : null;
}

function powershellFilesystemObservation(value) {
  let script = String(value).trim();
  if (!script || /\$\(|[&{}()]|`|\b(?:ForEach-Object|Where-Object)\b/iu.test(script)) return false;
  script = script.replace(/2\s*>\s*\$null\b/giu, '');
  if (/[<>]/u.test(script)) return false;
  const segments = script.split(/(?:\r?\n|;|\|)/u).map((item) => item.trim()).filter(Boolean);
  let listed = false;
  for (const segment of segments) {
    if (/^\$ErrorActionPreference\s*=\s*(['"])SilentlyContinue\1$/iu.test(segment)) continue;
    if (segment.includes('$')) return false;
    const command = /^([A-Za-z][A-Za-z0-9-]*)\b/u.exec(segment)?.[1]?.toLowerCase();
    if (!POWERSHELL_OBSERVATION_COMMANDS.has(command)) return false;
    if (command === 'get-childitem') listed = true;
  }
  return listed;
}
