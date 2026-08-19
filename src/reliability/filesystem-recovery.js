// SPDX-License-Identifier: Apache-2.0

const MISSING_PARENT_PREFIX = 'parent directory is missing; create exactly this directory first with fs.create_directory: ';

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
