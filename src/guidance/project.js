// SPDX-License-Identifier: Apache-2.0
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_DIRECTORIES = 32;
const MAX_DOCUMENTS = 64;
const MAX_DOCUMENT_BYTES = 65_536;
const MAX_TOTAL_BYTES = 131_072;
const AGENT_INSTRUCTION_NAMES = Object.freeze(['AGENTS.override.md', 'AGENTS.md']);

export class ProjectGuidance {
  constructor(workspaceRoot, options = {}) {
    this.root = resolve(workspaceRoot);
    this.telemetry = options.telemetry;
  }

  async resolve(records = []) {
    const root = await realpath(this.root);
    const directories = new Set([root]);
    for (const target of guidanceTargets(records).slice(-64)) {
      const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
      if (!inside(root, absolute)) continue;
      addAncestors(directories, root, absolute);
      addAncestors(directories, root, dirname(absolute));
    }
    const directoriesInScope = [...directories]
      .sort((left, right) => pathDepth(root, left) - pathDepth(root, right)
        || left.localeCompare(right)).slice(0, MAX_DIRECTORIES);
    const instructions = [];
    const memories = [];
    let total = 0;
    for (const directory of directoriesInScope) {
      const item = await firstDocument(root, directory, AGENT_INSTRUCTION_NAMES,
        'agent_instructions', this.telemetry);
      if (!item || total + item.bytes > MAX_TOTAL_BYTES) continue;
      instructions.push(item); total += item.bytes;
    }
    for (const directory of directoriesInScope) {
      if (instructions.length + memories.length >= MAX_DOCUMENTS) break;
      const item = await firstDocument(root, directory, ['NNA.md'], 'project_memory', this.telemetry);
      if (!item || total + item.bytes > MAX_TOTAL_BYTES) continue;
      memories.push(item); total += item.bytes;
    }
    // Invariant: mutable local memory is projected before portable repository instructions.
    // Later AGENTS.md content therefore wins when the two sources conflict.
    const items = [...memories, ...instructions];
    this.telemetry?.record('project.guidance', 'succeeded', {
      documents: items.map((item) => ({ path: item.path, bytes: Buffer.byteLength(item.content), depth: item.depth })),
      total_bytes: total,
    });
    return Object.freeze(items);
  }
}

async function firstDocument(root, directory, names, kind, telemetry) {
  for (const name of names) {
    const path = join(directory, name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DOCUMENT_BYTES) continue;
      const canonical = await realpath(path);
      if (!inside(root, canonical)) continue;
      const content = await readDocument(canonical);
      if (content === null) continue;
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes === 0 || bytes > MAX_DOCUMENT_BYTES) continue;
      return Object.freeze({
        path: relative(root, path) || name, content, bytes, kind,
        depth: pathDepth(root, directory), updatedAt: Math.trunc(metadata.mtimeMs),
      });
    } catch (error) {
      if (error.code !== 'ENOENT') telemetry?.record('project.guidance', 'failed', {
        relative_path: relative(root, path), code: error.code ?? 'guidance_read_failed',
      }, { reasonCode: error.code });
    }
  }
  return null;
}

async function readDocument(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > MAX_DOCUMENT_BYTES ? null : buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

function guidanceTargets(records) {
  const values = [];
  for (const record of records) {
    if (record?.type !== 'tool_request' || !record.args || typeof record.args !== 'object') continue;
    for (const key of ['path', 'source', 'destination']) {
      if (typeof record.args[key] === 'string' && record.args[key].length <= 4096) values.push(record.args[key]);
    }
  }
  return values;
}

function addAncestors(result, root, target) {
  let current = target;
  while (inside(root, current)) {
    result.add(current);
    if (samePath(current, root)) break;
    const parent = dirname(current);
    if (samePath(parent, current)) break;
    current = parent;
  }
}

function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function samePath(left, right) { return left === right; }
function pathDepth(root, path) { const value = relative(root, path); return value ? value.split(/[\\/]/u).length : 0; }
