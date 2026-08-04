// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_DOCUMENTS = 32;
const MAX_DOCUMENT_BYTES = 65_536;
const MAX_TOTAL_BYTES = 131_072;

export class ProjectGuidance {
  constructor(workspaceRoot, options = {}) {
    this.root = resolve(workspaceRoot);
    this.telemetry = options.telemetry;
  }

  async resolve(records = []) {
    const directories = new Set([this.root]);
    for (const target of guidanceTargets(records).slice(-64)) {
      const absolute = isAbsolute(target) ? resolve(target) : resolve(this.root, target);
      if (!inside(this.root, absolute)) continue;
      addAncestors(directories, this.root, absolute);
      addAncestors(directories, this.root, dirname(absolute));
    }
    const items = [];
    let total = 0;
    for (const directory of [...directories].sort((left, right) => left.length - right.length).slice(0, MAX_DOCUMENTS)) {
      const path = join(directory, 'NNA.md');
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DOCUMENT_BYTES) continue;
        const content = await readFile(path, 'utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes === 0 || total + bytes > MAX_TOTAL_BYTES) continue;
        items.push(Object.freeze({ path: relative(this.root, path) || 'NNA.md', content, depth: pathDepth(this.root, directory) }));
        total += bytes;
      } catch (error) {
        if (error.code !== 'ENOENT') this.telemetry?.record('project.guidance', 'failed', {
          relative_path: relative(this.root, path), code: error.code ?? 'guidance_read_failed',
        }, { reasonCode: error.code });
      }
    }
    this.telemetry?.record('project.guidance', 'succeeded', {
      documents: items.map((item) => ({ path: item.path, bytes: Buffer.byteLength(item.content), depth: item.depth })),
      total_bytes: total,
    });
    return Object.freeze(items);
  }
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

function samePath(left, right) { return left.toLowerCase() === right.toLowerCase(); }
function pathDepth(root, path) { const value = relative(root, path); return value ? value.split(/[\\/]/u).length : 0; }
