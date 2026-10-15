// SPDX-License-Identifier: Apache-2.0
/** Tray assets use the NNA brand supplied by the selected native installation. */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const output = resolve(import.meta.dirname, '..', 'packages', 'electron', 'assets');
const source = [resolve(import.meta.dirname, '../../resources/icons/notnative-agent-32.png'), resolve(import.meta.dirname, '../packages/electron/brand/nna.png')].find(existsSync);
if (!source) throw new Error('NNA tray brand asset is missing. Run the desktop installer against the selected NNA installation.');
mkdirSync(output, { recursive: true });
for (const state of ['running', 'stopped']) copyFileSync(source, join(output, `tray-${state}.png`));
process.stdout.write('NNA tray icons prepared.\n');
