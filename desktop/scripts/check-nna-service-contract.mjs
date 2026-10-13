// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Invariant: a paired build checks actual source, not just coincidentally matching examples.
const root = fileURLToPath(new URL('..', import.meta.url));
const nna = resolve(process.argv[2] ?? resolve(root, '../NotNativeAgent'));
for (const name of ['nnd-service-contract.js', 'nnd-manifest-extensions.js']) {
  const native = (await readFile(resolve(nna, 'src', name), 'utf8')).replaceAll('\r\n', '\n');
  const mirror = (await readFile(resolve(root, 'scripts', name), 'utf8')).replaceAll('\r\n', '\n')
    .replace("from './nnd-contract-error.js'", "from './ids.js'");
  assert.equal(mirror, native, `NNA/NND service contract drift: ${name}`);
}
process.stdout.write('paired NNA/NND service contracts match\n');
