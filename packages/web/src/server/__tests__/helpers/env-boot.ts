// SPDX-License-Identifier: Apache-2.0
/**
 * Data-dir boot shim for tunnel test files: imports evaluate in order, so
 * a side-effect module FIRST in the test file fixes NOTNATIVE_DATA_DIR
 * before env.ts/settings-store bindings initialize (the ENV object is a
 * static boot snapshot — a plain `process.env` assignment in the test body
 * would be too late).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';

const dir = mkdtempSync(`${tmpdir()}${sep}nnd-tunnel-boot-`);

process.env.NOTNATIVE_DATA_DIR = dir;
process.on('exit', () => {
  rmSync(dir, { recursive: true, force: true });
});

export const BOOT_DATA_DIR = dir;
