// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function readShellPrefs(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Replace the whole document only after the new copy is fully written. */
export function writeShellPrefs(file, patch) {
  const contents = `${JSON.stringify({ ...readShellPrefs(file), ...patch }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* original error is decisive */ }
    throw error;
  }
}
