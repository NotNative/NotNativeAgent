// SPDX-License-Identifier: Apache-2.0
import { mkdir, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ContractError } from '../ids.js';

export async function withPreparedWriteTarget(paths, request, signal, operation) {
  const parent = dirname(request.resolved.path);
  let createdRoot;
  let completed = false;
  try {
    if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
    createdRoot = await mkdir(parent, { recursive: true });
    const current = await paths.resolveWrite(request.args.path);
    if (!samePath(current.path, request.resolved.path)) {
      throw new ContractError('tool_revalidation_drift', 'write target changed after review');
    }
    const result = await operation();
    completed = true;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ContractError('tool_result_invalid', 'write operation returned an invalid receipt');
    }
    return {
      ...result,
      metadata: { ...result.metadata, parent_directories_created: createdRoot !== undefined },
    };
  } catch (error) {
    const rollbackCode = completed ? null : await rollbackCreatedParents(createdRoot, parent);
    if (rollbackCode && error && typeof error === 'object') error.rollbackCode = rollbackCode;
    throw error;
  }
}

async function rollbackCreatedParents(createdRoot, leafParent) {
  if (typeof createdRoot !== 'string') return null;
  const boundary = resolve(createdRoot);
  let current = resolve(leafParent);
  const relation = relative(boundary, current);
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) return null;
  while (true) {
    try { await rmdir(current); }
    catch (error) {
      return ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)
        ? null : error.code ?? 'tool_parent_rollback_failed';
    }
    if (samePath(current, boundary)) break;
    current = dirname(current);
  }
  return null;
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
