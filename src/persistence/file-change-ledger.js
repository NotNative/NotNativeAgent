// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { ContractError } from '../ids.js';

const MAX_SNAPSHOT_BYTES = 1_048_576;
const MAX_FILES = 256;

export class FileChangeLedger {
  #root;
  #entries = new Map();

  constructor(root) { this.#root = root; }

  record(path, before, after, operation) {
    const prior = this.#entries.get(path);
    const entry = Object.freeze({
      path,
      displayPath: displayPath(this.#root, path),
      before: prior?.before ?? captureContentSnapshot(before),
      after: captureContentSnapshot(after),
      operations: Object.freeze([...(prior?.operations ?? []), operation].slice(-64)),
      updatedAt: Date.now(),
    });
    // Delete/reinsert makes the Map's insertion order an LRU order.
    this.#entries.delete(path);
    this.#entries.set(path, entry);
    while (this.#entries.size > MAX_FILES) this.#entries.delete(this.#entries.keys().next().value);
  }

  diff(path = null) {
    const entries = [...this.#entries.values()].filter((entry) => !path || matches(entry, path));
    if (path && entries.length === 0) throw new ContractError('diff_target_missing', `no NNA-recorded changes match ${path}`);
    const changed = entries.filter((entry) => entry.before.sha256 !== entry.after.sha256);
    if (changed.length === 0) return 'No NNA-recorded file changes in this conversation.';
    return changed.map(renderEntry).join('\n\n');
  }

  snapshot() {
    return Object.freeze([...this.#entries.values()].map((entry) => Object.freeze({
      path: entry.displayPath, before_sha256: entry.before.sha256, after_sha256: entry.after.sha256,
      operations: entry.operations, updated_at: entry.updatedAt,
    })));
  }
}

function captureContentSnapshot(value) {
  if (value === null || value === undefined) return Object.freeze({ exists: false, bytes: 0, sha256: null, content: null, binary: false, truncated: false });
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Object.freeze({
    exists: true, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
    content: buffer.length <= MAX_SNAPSHOT_BYTES ? buffer.toString('utf8') : null,
    binary: buffer.includes(0), truncated: buffer.length > MAX_SNAPSHOT_BYTES,
  });
}

function renderEntry(entry) {
  const header = `--- ${entry.before.exists ? `a/${entry.displayPath}` : '/dev/null'}\n+++ ${entry.after.exists ? `b/${entry.displayPath}` : '/dev/null'}`;
  if (entry.before.binary || entry.after.binary) return `${header}\nBinary file changed (${entry.before.bytes} -> ${entry.after.bytes} bytes)`;
  if (entry.before.truncated || entry.after.truncated) return `${header}\nFile changed (${entry.before.bytes} -> ${entry.after.bytes} bytes; content exceeds diff snapshot bound)`;
  const before = lines(entry.before.content ?? '');
  const after = lines(entry.after.content ?? '');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const contextBefore = before.slice(Math.max(0, prefix - 3), prefix);
  const contextAfter = after.slice(after.length - suffix, Math.min(after.length, after.length - suffix + 3));
  const oldStart = Math.max(1, prefix - contextBefore.length + 1);
  const newStart = Math.max(1, prefix - contextBefore.length + 1);
  const body = [
    ...contextBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
  ];
  return `${header}\n@@ -${oldStart},${contextBefore.length + removed.length + contextAfter.length} +${newStart},${contextBefore.length + added.length + contextAfter.length} @@\n${body.join('\n')}`;
}

function lines(value) {
  if (!value) return [];
  const result = value.replace(/\r\n/gu, '\n').split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}

function displayPath(root, path) {
  const value = relative(root, path);
  if (!isAbsolute(value) && value !== '..' && !value.startsWith('../') && !value.startsWith('..\\')) return value.replaceAll('\\', '/') || '.';
  return path.replaceAll('\\', '/');
}

function matches(entry, requested) {
  const normalized = comparablePath(requested);
  const display = comparablePath(entry.displayPath);
  const absolute = comparablePath(entry.path);
  return display === normalized || absolute === normalized || display.endsWith(`/${normalized}`);
}

function comparablePath(value) {
  const normalized = String(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
