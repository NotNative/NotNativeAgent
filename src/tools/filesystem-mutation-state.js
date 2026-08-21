// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ContractError, newId } from '../ids.js';

export async function transactionalSnapshot(resolved) {
  const content = await readFile(resolved.path, 'utf8');
  return transactionalReceipt(resolved.path, content, sha256(content));
}

export function transactionalReceipt(path, content, digest) {
  return Object.freeze({
    id: newId('transaction_receipt'), origin: 'runtime_transaction', path, digest,
    bytes: Buffer.byteLength(content, 'utf8'), observedAt: Date.now(),
  });
}

export function mutationEvidence(operation, beforeSha256, afterContent, beforeBytes) {
  return Object.freeze({ operation, before_sha256: beforeSha256, after_sha256: sha256(afterContent),
    before_bytes: beforeBytes, after_bytes: Buffer.byteLength(afterContent, 'utf8') });
}

export async function advanceFromAuthoredState(request, receipts) {
  let content;
  try { content = await readFile(request.resolved.path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && request.resolved.exists === false) return { request, advanced: false };
    throw error;
  }
  const digest = sha256(content);
  if (request.resolved.exists !== false && digest === request.args.expected_sha256) return { request, advanced: false };
  const receipt = receipts.peek(request.resolved.path, { full: true });
  if (receipt?.origin !== 'authored_write' || receipt.digest !== digest) {
    throw new ContractError('tool_revalidation_drift', 'target changed after review');
  }
  return {
    advanced: true,
    request: {
      ...request,
      args: { ...request.args, expected_sha256: digest },
      resolved: {
        ...request.resolved, exists: true, size: Buffer.byteLength(content, 'utf8'),
        readReceiptId: receipt.id, readReceiptSha256: digest, transactionalReceipt: null,
      },
    },
  };
}

export function withAuthoredAdvanceMetadata(result, advanced) {
  if (!advanced) return result;
  return { ...result, metadata: { ...result.metadata, advanced_from_authored_state: true } };
}

function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
