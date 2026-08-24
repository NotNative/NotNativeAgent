// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ContractError } from '../ids.js';
import { prepareTextEdit } from '../stale-edit-recovery.js';
import { normalizeArgumentAliases } from './argument-normalization.js';
import { advanceFromAuthoredState, mutationEvidence, transactionalReceipt,
  withAuthoredAdvanceMetadata } from './filesystem-mutation-state.js';
import { countOccurrences, replaceText } from './text-edit-helpers.js';

const MAX_TEXT_BYTES = 1_048_576;
const MAX_EDIT_FIND_BYTES = 16_384;
const MAX_EDIT_CONTENT_BYTES = 32_768;
const MAX_EDIT_ARGUMENT_BYTES = 40_960;

export function filesystemEditDefinition(paths, changes, receipts, atomicWrite, verifyExpectedState) {
  return {
    name: 'fs.edit_text', version: 4,
    purpose: 'Replace one exact, normally unique text match in an existing UTF-8 file. Supply only path, find, content, and optionally all; use fs.edit_lines instead when selecting by line number. Use an empty content string to delete the matched text. Read the relevant file first when practical; NNA still snapshots and revalidates every edit.',
    sideEffect: 'reversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Required path to the existing UTF-8 file.' },
      content: { type: 'string', maxLength: MAX_EDIT_CONTENT_BYTES, description: 'Required replacement text, at most 32 KiB. Keep this to the smallest complete change; use multiple anchored edits for large rewrites. Use an empty string to delete the selected text.' },
      find: { type: 'string', minLength: 1, maxLength: MAX_EDIT_FIND_BYTES, description: 'Smallest exact text, at most 16 KiB, that uniquely anchors the replacement. Normally must occur once; use all only when every occurrence should change. Find plus content must stay within 40 KiB.' },
      all: { type: 'boolean', description: 'Replace every exact occurrence instead of requiring one unique match. Defaults to false.' },
    }, ['path', 'find', 'content']),
    normalizeArgs: (args) => normalizeArgumentAliases(args, {
      path: ['filePath', 'file_path'],
      find: ['old_text', 'oldString', 'oldText', 'search'],
      content: ['new_text', 'newString', 'newText', 'replacement', 'text'],
      all: ['replace_all', 'replaceAll'],
    }),
    validate: async (args) => validateEdit(paths, args, receipts),
    executor: (request, signal) => executeEdit(request, signal, changes, receipts, atomicWrite, verifyExpectedState),
  };
}

async function validateEdit(paths, args, receipts) {
  requireShape(args, ['path', 'find', 'content'], ['all']);
  const findBytes = Buffer.byteLength(args.find, 'utf8');
  const contentBytes = Buffer.byteLength(args.content, 'utf8');
  if (findBytes > MAX_EDIT_FIND_BYTES || contentBytes > MAX_EDIT_CONTENT_BYTES
    || findBytes + contentBytes > MAX_EDIT_ARGUMENT_BYTES) {
    throw new ContractError('tool_arguments_too_large',
      'edit arguments exceed the provider-safe payload bound; select a smaller unique anchor and replacement');
  }
  if (args.find.length === 0 || (args.all !== undefined && typeof args.all !== 'boolean')) {
    throw invalid('find must be non-empty and all must be boolean');
  }
  return validateExactEdit(paths, args, receipts);
}

async function validateExactEdit(paths, args, receipts) {
  const { resolved, content, actual, receipt, transaction } = await editSnapshot(paths, args, receipts, { full: true });
  const exactArgs = {
    old_text: normalizeEditNeedle(content, args.find), new_text: args.content,
    replace_all: Boolean(args.all),
  };
  const boundArgs = { path: args.path, ...exactArgs, edit_mode: 'exact', expected_sha256: receipt?.digest ?? transaction?.digest };
  const prepared = receipt
    ? prepareTextEdit(receipts, resolved.path, boundArgs, content, actual)
    : { expectedSha256: actual, recovered: false };
  const occurrences = countOccurrences(content, exactArgs.old_text);
  if (occurrences === 0 || (!exactArgs.replace_all && occurrences !== 1)) {
    throw new ContractError('tool_edit_match_invalid', occurrences === 0
      ? 'find was not found in the current file snapshot'
      : 'find is not unique; provide more context or set all');
  }
  const updated = replaceText(content, exactArgs.old_text, exactArgs.new_text, exactArgs.replace_all);
  assertUpdatedBound(updated);
  return preparedEdit(resolved, receipt, transaction, prepared, boundArgs, updated, content, 'exact_text_edit');
}

async function editSnapshot(paths, args, receipts, coverage) {
  const resolved = await paths.withRecovery(await paths.resolveRead(args.path));
  if (resolved.size > MAX_TEXT_BYTES) throw new ContractError('tool_target_too_large', 'file exceeds edit bound');
  const content = await readFile(resolved.path, 'utf8');
  const actual = sha256(content);
  const receipt = receipts.peek(resolved.path, coverage);
  const transaction = !receipt && resolved.insideWorkspace ? transactionalReceipt(resolved.path, content, actual) : null;
  if (!receipt && !transaction) receipts.latest(resolved.path, coverage);
  return { resolved, content, actual, receipt, transaction };
}

function preparedEdit(resolved, receipt, transaction, prepared, boundArgs, updated, before, operation) {
  return {
    args: { ...boundArgs, expected_sha256: prepared.expectedSha256 },
    resolved: {
      ...resolved, staleEditRecovered: prepared.recovered,
      readReceiptId: receipt?.id ?? null, readReceiptSha256: receipt?.digest ?? null,
      transactionalReceipt: transaction,
      mutationEvidence: mutationEvidence(operation, prepared.expectedSha256, updated, Buffer.byteLength(before, 'utf8')),
    },
  };
}

async function executeEdit(request, signal, changes, receipts, atomicWrite, verifyExpectedState) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
  const prepared = await advanceFromAuthoredState(request, receipts);
  await verifyExpectedState(prepared.request);
  const content = await readFile(prepared.request.resolved.path, 'utf8');
  const updated = executeExactReplacement(prepared.request, content);
  const replacements = prepared.request.args.replace_all ? countOccurrences(content, prepared.request.args.old_text) : 1;
  const result = await atomicWrite({ ...prepared.request, args: { ...prepared.request.args, content: updated } }, signal, {
    message: 'edit completed', replacements,
  }, changes);
  receipts.recordAuthored(prepared.request.resolved.path, sha256(updated), updated);
  return withAuthoredAdvanceMetadata(result, prepared.advanced);
}

function executeExactReplacement(request, content) {
  const occurrences = countOccurrences(content, request.args.old_text);
  if (occurrences === 0 || (!request.args.replace_all && occurrences !== 1)) throw drift('edit match changed after review');
  return replaceText(content, request.args.old_text, request.args.new_text, request.args.replace_all);
}

function normalizeEditNeedle(content, find) {
  if (countOccurrences(content, find) > 0 || !/[\r\n]/u.test(find)) return find;
  return content.includes('\r\n') ? find.replace(/\r?\n/gu, '\r\n') : find.replace(/\r\n/gu, '\n');
}

function assertUpdatedBound(content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    throw new ContractError('tool_arguments_too_large', 'edited content exceeds bound');
  }
}

function requireShape(value, required, optional) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('tool arguments must be an object');
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw invalid(`required argument "${missing}" is missing`);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw invalid(`unknown argument "${unknown}"`);
  if (typeof value.path !== 'string' || typeof value.content !== 'string') throw invalid('tool argument types are invalid');
}

function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
function invalid(message) { return new ContractError('tool_schema_invalid', message); }
function drift(message) { return new ContractError('tool_revalidation_drift', message); }
function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
