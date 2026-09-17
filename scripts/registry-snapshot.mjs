// SPDX-License-Identifier: Apache-2.0
/**
 * settings-registry snapshot generator (doc 14 §F.4): renders the registry as
 * `{version, fields}` (flags only; parsers stay code-side) and writes the
 * checked-in web-server copy. Run after EVERY registry edit — the staleness
 * test (lib/settings/registry.test.ts) fails otherwise.
 */
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSnapshot } from './registry-render.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { SETTINGS_REGISTRY, REGISTRY_SNAPSHOT_VERSION } = await import('../packages/ui/src/lib/settings/registry.ts');

const outPath = resolve(root, 'packages/web/src/server/lib/settings-registry.json');
const snapshot = renderSnapshot(SETTINGS_REGISTRY, REGISTRY_SNAPSHOT_VERSION);
await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
process.stdout.write(`settings registry snapshot: ${Object.keys(snapshot.fields).length} fields -> packages/web/src/server/lib/settings-registry.json\n`);
