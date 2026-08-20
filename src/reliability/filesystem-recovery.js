// SPDX-License-Identifier: Apache-2.0
import { dirname, normalize, resolve } from 'node:path';

const MISSING_PARENT_PREFIX = 'parent directory is missing; create exactly this directory first with fs.create_directory: ';
const DIRECT_CHILD_PROOF_TOOLS = new Set([
  'fs.read_text', 'fs.read_lines', 'fs.write_text', 'fs.edit_text', 'fs.edit_lines',
]);

export function missingFilesystemPrerequisite(item) {
  if (item?.result?.reason_code !== 'tool_parent_missing') return null;
  const content = String(item.result.content ?? '');
  if (!content.startsWith(MISSING_PARENT_PREFIX)) return null;
  const encoded = content.slice(MISSING_PARENT_PREFIX.length).split('\n', 1)[0];
  try {
    const path = JSON.parse(encoded);
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return null;
    return Object.freeze({ tool: 'fs.create_directory', path });
  } catch {
    return null;
  }
}

export function missingParentMessage(path) {
  return `${MISSING_PARENT_PREFIX}${JSON.stringify(path)}\n`
    + 'fs.create_directory creates only one directory level and never creates missing ancestors recursively.';
}

export function satisfiesFilesystemPrerequisite(item, prerequisite) {
  if (item?.result?.status !== 'succeeded' || prerequisite?.kind !== 'prerequisite_repair') return false;
  if (prerequisite.required_tool !== 'fs.create_directory' || typeof prerequisite.required_path !== 'string') return false;
  const tool = item.result.tool_name ?? item.call?.name;
  const candidate = item.request?.args?.path ?? item.call?.args?.path;
  if (typeof candidate !== 'string') return false;
  const required = comparablePath(prerequisite.required_path);
  if (['fs.create_directory', 'fs.list_directory'].includes(tool)) return comparablePath(candidate) === required;
  return DIRECT_CHILD_PROOF_TOOLS.has(tool) && comparablePath(dirname(resolve(candidate))) === required;
}

function comparablePath(value) {
  const absolute = normalize(resolve(value));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
