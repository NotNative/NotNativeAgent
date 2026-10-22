// SPDX-License-Identifier: Apache-2.0

const LIMIT = 40;

export function appendManifestDiagnostics(errors, differences, files, expected) {
  let emitted = 0;
  let omitted = 0;
  const add = (message) => {
    if (emitted < LIMIT) { errors.push(message); emitted += 1; }
    else omitted += 1;
  };
  for (const [name] of differences.mismatches) add(`release artifact mismatch: ${name}`);
  for (const name of files) {
    if (!expected.has(name)) add(`manifest missing file: ${name}`);
  }
  for (const name of differences.stale) add(`manifest references missing file: ${name}`);
  if (omitted > 0) errors.push(`${omitted} additional release manifest discrepancies omitted`);
}
