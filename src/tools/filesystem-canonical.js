// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';
import { ContractError } from '../ids.js';
import { normalizeArgumentAliases } from './argument-normalization.js';

const MAX_LIST_RESULTS = 1_000;
const MAX_LIST_DEPTH = 64;
const DIRECTORY_ARGUMENT_ALIASES = Object.freeze({
  action: ['operation'], path: ['directoryPath', 'directory_path'],
});
const READ_ARGUMENT_ALIASES = Object.freeze({
  path: ['filePath', 'file_path'], start_line: ['startLine'], line_count: ['lineCount', 'limit'],
});
const LIST_ARGUMENT_ALIASES = Object.freeze({
  path: ['directoryPath', 'directory_path'], pattern: ['glob', 'file_glob'],
  depth: ['max_depth', 'maxDepth'], max_results: ['limit', 'maxResults'],
});
const MAX_REMOVE_ENTRIES = 10_000;
const MAX_REMOVE_BYTES = 1_073_741_824;
const DEFAULT_SKIPS = new Set(['.git', 'node_modules']);

export function canonicalFilesystemDefinitions(paths, legacy) {
  const list = listDefinition(paths);
  return [readDefinition(legacy), list, directoryDefinition(paths, list)];
}

function readDefinition(legacy) {
  const whole = requiredLegacy(legacy, 'fs.read_text');
  const lines = requiredLegacy(legacy, 'fs.read_lines');
  return {
    name: 'fs.read', version: 1,
    purpose: 'Read bounded UTF-8 text from one accessible file. Omit line arguments for the complete file, or provide start_line and line_count for a numbered window. Every result records the snapshot receipt required by later edits.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Required path to one UTF-8 text file.' },
      start_line: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'Optional first one-based line. Omit for the complete file.' },
      line_count: { type: 'integer', minimum: 1, maximum: 400, description: 'Optional maximum lines to return. Defaults to 200 when start_line is provided; without start_line, begins at line 1.' },
    }, ['path']),
    normalizeArgs: (args) => normalizeArgumentAliases(args, READ_ARGUMENT_ALIASES),
    validate: async (args) => {
      shape(args, ['path'], ['start_line', 'line_count']);
      const windowed = args.start_line !== undefined || args.line_count !== undefined;
      const delegated = windowed
        ? await lines.validate({ path: args.path, start_line: args.start_line ?? 1, line_count: args.line_count ?? 200 })
        : await whole.validate({ path: args.path });
      return {
        args: {
          path: args.path,
          ...(windowed ? { start_line: delegated.args.start_line, line_count: delegated.args.line_count } : {}),
        },
        resolved: { ...delegated.resolved, readMode: windowed ? 'lines' : 'full' },
      };
    },
    executor: (request, signal) => {
      // args.mode is accepted only as an internal backward-compatibility path
      // for already-sealed requests created before readMode moved to metadata.
      const readMode = request.resolved.readMode ?? request.args.mode;
      const delegate = readMode === 'lines' ? lines : whole;
      const args = readMode === 'lines'
        ? { path: request.args.path, start_line: request.args.start_line, line_count: request.args.line_count }
        : { path: request.args.path };
      return delegate.executor({ ...request, args }, signal);
    },
  };
}

function listDefinition(paths) {
  return {
    name: 'fs.list', version: 1,
    purpose: 'List a bounded accessible directory tree or matching path names with file metadata.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 120_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Existing file or directory to inspect. Defaults to the working directory.' },
      pattern: { type: 'string', minLength: 1, maxLength: 1024, description: 'Optional glob matched against descendant file and directory paths.' },
      depth: { type: 'integer', minimum: 1, maximum: MAX_LIST_DEPTH, description: 'Maximum descendant depth, where immediate children are depth 1. Defaults to 2 for a tree and 32 for a pattern search.' },
      max_results: { type: 'integer', minimum: 1, maximum: MAX_LIST_RESULTS, description: 'Maximum entries returned. Defaults to 200.' },
    }, []),
    normalizeArgs: (args) => normalizeArgumentAliases(args, LIST_ARGUMENT_ALIASES),
    validate: async (args) => {
      shape(args, [], ['path', 'pattern', 'depth', 'max_results']);
      const path = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
      const resolved = await paths.resolveMetadata(path);
      if (!['file', 'directory'].includes(resolved.kind)) throw new ContractError('tool_target_invalid', 'fs.list path must identify a regular file or directory');
      const pattern = args.pattern;
      if (pattern !== undefined) validateGlob(pattern);
      return {
        args: {
          path, ...(pattern === undefined ? {} : { pattern }),
          depth: integer(args.depth, pattern === undefined ? 2 : 32, 1, MAX_LIST_DEPTH),
          max_results: integer(args.max_results, 200, 1, MAX_LIST_RESULTS),
        },
        resolved,
      };
    },
    executor: async (request, signal) => {
      if (request.resolved.kind === 'file') {
        const name = request.args.path;
        if (request.args.pattern && !globMatch(name.replaceAll('\\', '/'), request.args.pattern)) return listResult([], request, false, []);
        return listResult([entryLine('file', '.', request.resolved.size, request.resolved.modifiedMs)], request, false, []);
      }
      const walked = await walkDirectory(request.resolved.path, request.args, signal);
      return listResult(walked.lines, request, walked.truncated, walked.skipped);
    },
  };
}

function directoryDefinition(paths, list) {
  return {
    name: 'fs.directory', version: 1,
    purpose: 'List the immediate children of, create, or remove one accessible directory. Create is recursive and idempotent. Removal is bounded and revalidated.',
    sideEffect: 'reversible', scope: 'workspace', cancellation: true, timeoutMs: 30_000,
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['list', 'create', 'remove'], description: 'Required directory operation.' },
      path: { type: 'string', maxLength: 4096, description: 'Required directory path.' },
      recursive: { type: 'boolean', description: 'Create defaults true. Remove defaults false and then requires an empty directory.' },
    }, ['action', 'path']),
    normalizeArgs: (args) => normalizeArgumentAliases(args, DIRECTORY_ARGUMENT_ALIASES),
    validate: (args) => validateDirectoryArgs(args, paths, list),
    executor: (request, signal) => executeDirectory(request, signal, paths, list),
  };
}

async function validateDirectoryArgs(args, paths, list) {
  shape(args, ['action', 'path'], ['recursive']);
  if (!['list', 'create', 'remove'].includes(args.action) || (args.recursive !== undefined && typeof args.recursive !== 'boolean')
    || (args.action === 'list' && args.recursive !== undefined)) {
    throw invalid('fs.directory action or recursive value is invalid');
  }
  if (args.action === 'list') {
    const listed = await list.validate({ path: args.path, depth: 1, max_results: 200 });
    return { args: { action: 'list', path: args.path, depth: 1, max_results: 200 }, resolved: listed.resolved };
  }
  const recursive = args.recursive ?? (args.action === 'create');
  if (args.action === 'create') {
    const resolved = await paths.resolveDirectoryWrite(args.path);
    return { args: { action: 'create', path: args.path, recursive }, resolved: { ...resolved, operation: 'create' } };
  }
  const resolved = await paths.resolveDirectory(args.path);
  paths.assertMutationTarget(resolved.path);
  const snapshot = await directorySnapshot(resolved.path, recursive);
  return {
    args: { action: 'remove', path: args.path, recursive },
    resolved: { ...resolved, recovery: 'none', operation: 'remove', recursive, directorySnapshot: snapshot },
  };
}

async function executeDirectory(request, signal, paths, list) {
  abort(signal);
  if (request.args.action === 'list') {
    const result = await list.executor({ ...request, args: {
      path: request.args.path, depth: request.args.depth, max_results: request.args.max_results,
    } }, signal);
    return { ...result, metadata: { ...result.metadata, action: 'list' } };
  }
  if (request.args.action === 'create') {
    await mkdir(request.resolved.path, { recursive: request.args.recursive });
    abort(signal);
    const current = await paths.resolveDirectory(request.resolved.path);
    if (!samePath(current.path, request.resolved.path)) throw new ContractError('tool_revalidation_drift', 'directory target changed after review');
    return {
      content: request.resolved.exists ? 'directory already exists' : 'directory created',
      metadata: { action: 'create', path: request.args.path, created: !request.resolved.exists, recursive: request.args.recursive },
    };
  }
  paths.assertMutationTarget(request.resolved.path);
  const current = await directorySnapshot(request.resolved.path, request.args.recursive);
  if (current.digest !== request.resolved.directorySnapshot.digest) {
    throw new ContractError('tool_revalidation_drift', 'directory contents changed after review');
  }
  abort(signal);
  if (request.args.recursive) await rm(request.resolved.path, { recursive: true, force: false });
  else await rmdir(request.resolved.path);
  return {
    content: 'directory removed',
    metadata: { action: 'remove', path: request.args.path, recursive: request.args.recursive,
      entries: current.entries, bytes: current.bytes },
  };
}

async function walkDirectory(root, args, signal) {
  const lines = [];
  const skipped = [];
  const pending = [{ path: root, relativePath: '', depth: 0 }];
  let truncated = false;
  while (pending.length > 0) {
    abort(signal);
    const current = pending.shift();
    const entries = (await readdir(current.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      abort(signal);
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory() && DEFAULT_SKIPS.has(entry.name)) {
        skipped.push(relativePath);
        continue;
      }
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
      const depth = current.depth + 1;
      if (!args.pattern || globMatch(relativePath, args.pattern)) {
        let size = null; let modifiedMs = null;
        try { const info = await stat(join(current.path, entry.name)); size = info.size; modifiedMs = info.mtimeMs; } catch { /* bounded listing tolerates races */ }
        lines.push(entryLine(kind, relativePath, size, modifiedMs));
        if (lines.length >= args.max_results) { truncated = true; return { lines, truncated, skipped }; }
      }
      if (entry.isDirectory() && depth < args.depth) pending.push({ path: join(current.path, entry.name), relativePath, depth });
    }
  }
  return { lines, truncated, skipped };
}

async function directorySnapshot(root, recursive) {
  const records = [];
  const pending = [{ path: root, relativePath: '' }];
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.shift();
    const entries = (await readdir(current.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    if (!recursive && entries.length > 0) throw new ContractError('tool_directory_not_empty', 'non-recursive directory removal requires an empty directory');
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new ContractError('tool_directory_link_blocked', 'recursive directory removal does not admit symbolic links or junctions');
      const info = await stat(path);
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      bytes += entry.isFile() ? info.size : 0;
      records.push(`${kind}\t${relativePath}\t${info.size}\t${Math.trunc(info.mtimeMs)}`);
      if (records.length > MAX_REMOVE_ENTRIES || bytes > MAX_REMOVE_BYTES) {
        throw new ContractError('tool_directory_remove_bound', 'directory removal exceeds the 10000-entry or 1-GiB safety bound');
      }
      if (entry.isDirectory()) pending.push({ path, relativePath });
    }
  }
  return Object.freeze({ digest: createHash('sha256').update(records.join('\n')).digest('hex'), entries: records.length, bytes });
}

function listResult(lines, request, truncated, skipped) {
  const notices = [];
  if (skipped.length > 0) notices.push(`skipped default directories: ${skipped.join(', ')}`);
  if (truncated) notices.push(`truncated at max_results=${request.args.max_results}`);
  const listing = lines.join('\n') || (request.args.pattern ? 'no matching paths' : 'empty directory');
  return {
    content: [...notices, listing].join('\n'),
    metadata: {
      path: request.args.path, pattern: request.args.pattern ?? null, depth: request.args.depth,
      entries: lines.length, skipped, truncated,
    },
  };
}

function entryLine(kind, path, size, modifiedMs) {
  return `${kind}\t${path}\t${size ?? '-'}\t${modifiedMs == null ? '-' : new Date(modifiedMs).toISOString()}`;
}

function validateGlob(pattern) {
  if (typeof pattern !== 'string' || !pattern.length) throw invalid('pattern must be a non-empty glob string');
  try { matchesGlob('probe', pattern); } catch { throw new ContractError('tool_pattern_invalid', 'glob pattern is invalid'); }
}
function globMatch(path, pattern) {
  try { return matchesGlob(path, pattern); } catch { throw new ContractError('tool_pattern_invalid', 'glob pattern is invalid'); }
}
function requiredLegacy(legacy, name) {
  const definition = legacy.get(name);
  if (!definition) throw new ContractError('tool_dependency_missing', `canonical filesystem tool requires ${name}`);
  return definition;
}
function shape(args, required, optional) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('tool arguments must be an object');
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !Object.hasOwn(args, key));
  if (missing) throw invalid(`required argument "${missing}" is missing`);
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (unknown) throw invalid(`unknown argument "${unknown}"`);
}
function integer(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid('integer argument is outside its bound');
  return value;
}
function samePath(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function abort(signal) { if (signal?.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled'); }
function invalid(message) { return new ContractError('tool_schema_invalid', message); }
function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
