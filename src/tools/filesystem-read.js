// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError, newId } from '../ids.js';

const MAX_TEXT_BYTES = 1_048_576;

export function filesystemReadDefinitions(paths, receipts, references = null) {
  return [listDefinition(paths), readDefinition(paths, receipts, references), readLinesDefinition(paths, receipts, references)];
}

export class ReadReceiptLedger {
  #receipts = new Map();
  #snapshotBytes = 0;

  record(path, digest, coverage = {}, snapshot = null) {
    const prior = this.#receipts.get(path);
    const ranges = prior?.digest === digest ? [...prior.ranges] : [];
    if (Number.isSafeInteger(coverage.start) && Number.isSafeInteger(coverage.end)) ranges.push([coverage.start, coverage.end]);
    const retainedSnapshot = typeof snapshot === 'string' ? snapshot : prior?.digest === digest ? prior.snapshot : null;
    const receipt = Object.freeze({
      id: newId('read_receipt'), path, digest, readAt: Date.now(),
      full: coverage.full === true || (prior?.digest === digest && prior.full === true),
      ranges: Object.freeze(mergeRanges(ranges)),
      snapshot: retainedSnapshot,
    });
    this.#snapshotBytes -= snapshotBytes(prior?.snapshot);
    this.#receipts.delete(path);
    this.#receipts.set(path, receipt);
    this.#snapshotBytes += snapshotBytes(retainedSnapshot);
    while (this.#receipts.size > 2048 || this.#snapshotBytes > 16_777_216) this.#evictOldest();
    return receipt;
  }

  require(path, digest, coverage = {}) {
    const receipt = this.#receipts.get(path);
    this.#requireCoverage(receipt, coverage);
    if (receipt.digest !== digest) throw receiptRequired();
    return receipt;
  }

  latest(path, coverage = {}) {
    const receipt = this.#receipts.get(path);
    this.#requireCoverage(receipt, coverage);
    return receipt;
  }

  contentFor(path, digest, coverage = {}) {
    const receipt = this.require(path, digest, coverage);
    if (typeof receipt.snapshot !== 'string') {
      throw new ContractError('read_receipt_required', 'read the relevant file snapshot again before editing it');
    }
    return receipt.snapshot;
  }

  #evictOldest() {
    const key = this.#receipts.keys().next().value;
    if (key === undefined) return;
    const receipt = this.#receipts.get(key);
    this.#snapshotBytes -= snapshotBytes(receipt?.snapshot);
    this.#receipts.delete(key);
  }

  #requireCoverage(receipt, coverage) {
    const rangeCovered = coverage.start === undefined || receipt?.full === true
      || receipt?.ranges.some(([start, end]) => start <= coverage.start && end >= coverage.end);
    if (!receipt || (coverage.full === true && !receipt.full) || !rangeCovered) throw receiptRequired();
  }
}

function receiptRequired() {
  return new ContractError(
    'read_receipt_required',
    'read the current file with fs.read_text before changing, moving, copying, or deleting it',
  );
}

function snapshotBytes(value) { return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0; }

function readDefinition(paths, receipts, references) {
  return {
    name: 'fs.read_text', version: 1, purpose: 'Read bounded UTF-8 text from one accessible file. Relative paths start at the working directory; root NNA may use absolute host paths.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Required path to one UTF-8 text file.' },
    }, ['path']),
    validate: async (args) => {
      requireShape(args, ['path']);
      const resolved = await paths.resolveRead(args.path);
      if (resolved.size > MAX_TEXT_BYTES) throw new ContractError('tool_target_too_large', 'file exceeds read bound');
      return { args: { path: args.path }, resolved };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const content = await readFile(request.resolved.path, 'utf8');
      const digest = sha256(content);
      const receipt = receipts.record(request.resolved.path, digest, { full: true }, content);
      const refs = observedFileReferences(references, request.resolved.path, receipt, { full: true });
      return {
        content,
        metadata: {
          bytes: Buffer.byteLength(content), path: request.args.path,
          sha256: digest, snapshot_id: `sha256:${digest}`, read_receipt: receipt.id, ...refs,
        },
      };
    },
  };
}

function readLinesDefinition(paths, receipts, references) {
  return {
    name: 'fs.read_lines', version: 1,
    purpose: 'Read a bounded numbered line window with an exact snapshot tag for anchored edits.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Required path to one UTF-8 text file.' },
      start_line: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'First one-based line to return. Defaults to 1.' },
      line_count: { type: 'integer', minimum: 1, maximum: 400, description: 'Maximum number of lines to return. Defaults to 200.' },
    }, ['path']),
    validate: async (args) => {
      requireShape(args, ['path'], ['start_line', 'line_count']);
      if (args.start_line !== undefined && (!Number.isSafeInteger(args.start_line) || args.start_line < 1)) {
        throw new ContractError('tool_schema_invalid', 'start_line must be a positive integer');
      }
      if (args.line_count !== undefined && (!Number.isSafeInteger(args.line_count) || args.line_count < 1 || args.line_count > 400)) {
        throw new ContractError('tool_schema_invalid', 'line_count must be between 1 and 400');
      }
      const resolved = await paths.resolveRead(args.path);
      if (resolved.size > MAX_TEXT_BYTES) throw new ContractError('tool_target_too_large', 'file exceeds structured read bound');
      return { args: { path: args.path, start_line: args.start_line ?? 1, line_count: args.line_count ?? 200 }, resolved };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const content = await readFile(request.resolved.path, 'utf8');
      const digest = sha256(content);
      const lines = logicalLines(content);
      if (request.args.start_line > Math.max(1, lines.length)) {
        throw new ContractError('read_line_out_of_range', 'start_line is beyond the end of the file');
      }
      const start = request.args.start_line;
      const end = Math.min(lines.length, start + request.args.line_count - 1);
      const shown = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
      const receipt = receipts.record(request.resolved.path, digest, { start, end, full: start === 1 && end === lines.length }, content);
      const refs = observedFileReferences(references, request.resolved.path, receipt, { start, end });
      return {
        content: `snapshot sha256:${digest} lines ${start}-${end} of ${lines.length}\n${shown}`,
        metadata: {
          path: request.args.path, sha256: digest, snapshot_id: `sha256:${digest}`,
          read_receipt: receipt.id, start_line: start, end_line: end, total_lines: lines.length, ...refs,
        },
      };
    },
  };
}

function observedFileReferences(references, path, receipt, coverage) {
  if (!references) return {};
  const pathRef = references.remember('path', path, 'filesystem_observation');
  const snapshotRef = references.remember('snapshot', {
    path_ref: pathRef.id, sha256: receipt.digest, read_receipt: receipt.id, coverage,
  }, 'filesystem_observation');
  return { path_ref: pathRef.id, snapshot_ref: snapshotRef.id };
}

function listDefinition(paths) {
  return {
    name: 'fs.list_directory', version: 1,
    purpose: 'List a bounded accessible directory tree. Relative paths start at the working directory; root NNA may use absolute host paths.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Directory to list. Defaults to the working directory.' },
      depth: { type: 'integer', minimum: 1, maximum: 4, description: 'Number of directory levels to include. Defaults to 2.' },
    }, []),
    validate: async (args) => {
      requireListShape(args);
      const path = args.path === undefined || (typeof args.path === 'string' && args.path.trim().length === 0) ? '.' : args.path;
      const resolved = await paths.resolveDirectory(path);
      return { args: { path, depth: args.depth ?? 2 }, resolved };
    },
    executor: async (request, signal) => ({
      content: await directoryTree(request.resolved.path, request.args.depth, signal),
      metadata: { path: request.args.path, depth: request.args.depth },
    }),
  };
}

async function directoryTree(root, depth, signal) {
  const lines = [];
  const pending = [{ path: root, prefix: '', depth: 0 }];
  while (pending.length > 0 && lines.length < 512) {
    if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
    const current = pending.shift();
    const entries = (await readdir(current.path, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (lines.length >= 512) break;
      const relativePath = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
      lines.push(`${kind}\t${relativePath}`);
      if (entry.isDirectory() && current.depth + 1 < depth) {
        pending.push({ path: join(current.path, entry.name), prefix: relativePath, depth: current.depth + 1 });
      }
    }
  }
  if (pending.length > 0 || lines.length >= 512) lines.push('truncated\tlisting reached the 512-entry bound');
  return lines.join('\n') || 'empty directory';
}

function mergeRanges(ranges) {
  const sorted = ranges.slice(0, 2048).sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const range of sorted) {
    const prior = merged.at(-1);
    if (prior && range[0] <= prior[1] + 1) prior[1] = Math.max(prior[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function logicalLines(content) {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.length > 0 ? lines : [''];
}

function requireShape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('tool_schema_invalid', 'tool arguments must be an object');
  }
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new ContractError('tool_schema_invalid', `required argument "${missing}" is missing`);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new ContractError('tool_schema_invalid', `unknown argument "${unknown}"`);
  if (typeof value.path !== 'string') throw new ContractError('tool_schema_invalid', 'tool argument types are invalid');
}

function requireListShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['path', 'depth'].includes(key))
    || (value.path !== undefined && typeof value.path !== 'string')
    || (value.depth !== undefined && (!Number.isInteger(value.depth) || value.depth < 1 || value.depth > 4))) {
    throw new ContractError('tool_schema_invalid', 'directory listing arguments are invalid');
  }
}

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}
