// SPDX-License-Identifier: Apache-2.0
import { openSync, fstatSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export function readBoundedText(file) {
  const fd = openSync(file, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16384) throw new Error('native-selection-invalid');
    const bytes = Buffer.alloc(16385); let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 16384) throw new Error('native-selection-invalid');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}
export function readBoundedJson(file) { return JSON.parse(readBoundedText(file)); }
export function canonicalDirectory(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)) {
    throw new Error('native-selection-invalid');
  }
  const root = realpathSync(value);
  if (!statSync(root).isDirectory()) throw new Error('native-selection-invalid');
  return root;
}
export function readNativeServiceSelection({ args, selectionFile, allowLegacy = false }) {
  const indices = args.flatMap((value, index) => value === '--nna-install-root' ? [index] : []);
  const legacy = args.includes('--legacy-local-dev');
  if (legacy) {
    if (!allowLegacy || indices.length) throw new Error('native-selection-conflict');
    return { mode: 'legacy' };
  }
  if (indices.length > 1) throw new Error('native-selection-conflict');
  let selected = indices.length ? args[indices[0] + 1] : undefined;
  if (!indices.length) {
    let value;
    try { value = readBoundedJson(selectionFile); }
    catch { throw new Error('native-selection-required'); }
    if (!value || Object.keys(value).sort().join(',') !== 'nna_install_root,schema_version'
      || value.schema_version !== '1.0') throw new Error('native-selection-invalid');
    selected = value.nna_install_root;
  }
  return { mode: 'native', installRoot: canonicalDirectory(selected) };
}
