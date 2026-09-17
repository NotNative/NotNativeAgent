// SPDX-License-Identifier: Apache-2.0
/**
 * Shared registry-snapshot renderer (doc 14 §F.4): both the generator script
 * and the staleness gate test import this so the snapshot shape is defined
 * EXACTLY once.
 */

export function renderField(field) {
  const snap = { scope: field.scope };
  for (const flag of ['perSurface', 'adopt', 'derived', 'secret', 'computed', 'local', 'owner']) {
    if (field[flag] !== undefined) snap[flag] = field[flag];
  }
  if (field.surfaces) snap.surfaces = [...field.surfaces];
  return snap;
}

export function renderSnapshot(SETTINGS_REGISTRY, snapshotVersion) {
  const fields = {};
  for (const field of SETTINGS_REGISTRY) fields[field.key] = renderField(field);
  return { version: snapshotVersion, fields };
}
