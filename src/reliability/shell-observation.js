// SPDX-License-Identifier: Apache-2.0

const POWERSHELL_FILESYSTEM_OBSERVATIONS = new Set(['get-childitem']);
const POWERSHELL_HOST_OBSERVATIONS = new Set([
  'get-ciminstance', 'get-computerinfo', 'get-counter', 'get-disk', 'get-eventlog',
  'get-hotfix', 'get-netadapter', 'get-nettcpconnection', 'get-netudpendpoint',
  'get-physicaldisk', 'get-process', 'get-scheduledtask', 'get-scheduledtaskinfo',
  'get-service', 'get-volume', 'get-winevent',
]);
const POWERSHELL_OBSERVATION_TRANSFORMS = new Set([
  'format-custom', 'format-list', 'format-table', 'format-wide', 'group-object',
  'measure-object', 'out-null', 'out-string', 'select-object', 'sort-object',
]);

export function shellObservationPurpose(script, shell) {
  return ['powershell', 'pwsh'].includes(shell) ? powershellObservationPurpose(script) : null;
}

function powershellObservationPurpose(value) {
  let script = String(value).trim();
  if (!script || /\$\(|[&{}()]|`|\b(?:ForEach-Object|Where-Object)\b/iu.test(script)) return false;
  script = script.replace(/2\s*>\s*\$null\b/giu, '');
  if (/[<>]/u.test(script)) return false;
  const segments = script.split(/(?:\r?\n|;|\|)/u).map((item) => item.trim()).filter(Boolean);
  let purpose = null;
  for (const segment of segments) {
    if (/^\$ErrorActionPreference\s*=\s*(['"])SilentlyContinue\1$/iu.test(segment)) continue;
    // Invariant: assigning the output of an allowlisted observation command to one
    // local variable changes no durable state. The right-hand side still passes the
    // same closed command grammar; other variable expressions remain uncertain.
    const assignment = /^\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/u.exec(segment);
    const operation = assignment?.[1]?.trim() ?? segment;
    if (operation.includes('$')) return false;
    const command = /^([A-Za-z][A-Za-z0-9-]*)\b/u.exec(operation)?.[1]?.toLowerCase();
    if (POWERSHELL_FILESYSTEM_OBSERVATIONS.has(command)) {
      purpose ??= 'filesystem_observation';
      continue;
    }
    if (POWERSHELL_HOST_OBSERVATIONS.has(command)) {
      purpose = 'host_observation';
      continue;
    }
    if (!POWERSHELL_OBSERVATION_TRANSFORMS.has(command)) return false;
  }
  return purpose;
}
