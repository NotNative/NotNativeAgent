// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ContractError } from '../ids.js';
import { prepareLineEdit, prepareTextEdit } from '../stale-edit-recovery.js';
import { normalizeArgumentAliases } from './argument-normalization.js';
import { advanceFromAuthoredState, mutationEvidence, transactionalReceipt,
  withAuthoredAdvanceMetadata } from './filesystem-mutation-state.js';
import { countOccurrences, logicalLines, replaceLineRange, replaceText } from './text-edit-helpers.js';

const MAX_TEXT_BYTES = 1_048_576;
const MAX_EDIT_ARGUMENT_BYTES = 65_536;

export function filesystemEditDefinition(paths, changes, receipts, atomicWrite, verifyExpectedState) {
  return {
    name: 'fs.edit_text', version: 2,
    purpose: 'Make one bounded edit to an existing UTF-8 file. Supply path and content, then select the target with either find for an exact normally-unique match, or start_line with optional end_line for an inclusive line range. Use an empty content string to delete the selected text. Read the relevant file first when practical; NNA still snapshots and revalidates every edit.',
    sideEffect: 'reversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Required path to the existing UTF-8 file.' },
      content: { type: 'string', maxLength: MAX_EDIT_ARGUMENT_BYTES, description: 'Required replacement text. Use an empty string to delete the selected text.' },
      find: { type: 'string', minLength: 1, maxLength: MAX_EDIT_ARGUMENT_BYTES, description: 'Exact text to replace. Normally must occur once; use all only when every occurrence should change.' },
      start_line: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'One-based first line of an inclusive replacement range. Do not combine with find.' },
      end_line: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'Optional one-based last line. Defaults to start_line and may span at most 400 lines.' },
      all: { type: 'boolean', description: 'With find only, replace every exact occurrence. Defaults to false.' },
    }, ['path', 'content']),
    normalizeArgs: (args) => normalizeArgumentAliases(args, {
      path: ['filePath', 'file_path'],
      find: ['old_text', 'oldString', 'oldText', 'search'],
      content: ['new_text', 'newString', 'newText', 'replacement', 'text'],
      start_line: ['start', 'startLine', 'line'],
      end_line: ['end', 'endLine'],
      all: ['replace_all', 'replaceAll'],
    }),
    validate: async (args) => validateEdit(paths, args, receipts),
    executor: (request, signal) => executeEdit(request, signal, changes, receipts, atomicWrite, verifyExpectedState),
  };
}

async function validateEdit(paths, args, receipts) {
  requireShape(args, ['path', 'content'], ['find', 'start_line', 'end_line', 'all']);
  const hasFind = Object.hasOwn(args, 'find');
  const hasStart = Object.hasOwn(args, 'start_line');
  if (hasFind === hasStart) throw invalid('select exactly one edit target: find or start_line');
  if (Object.hasOwn(args, 'end_line') && !hasStart) throw invalid('end_line requires start_line');
  if (Object.hasOwn(args, 'all') && !hasFind) throw invalid('all is only valid with find');
  if (Buffer.byteLength(args.content, 'utf8') > MAX_EDIT_ARGUMENT_BYTES
    || (hasFind && Buffer.byteLength(args.find, 'utf8') > MAX_EDIT_ARGUMENT_BYTES)) {
    throw new ContractError('tool_arguments_too_large', 'edit arguments exceed the 65536-byte bound; edit a smaller region');
  }
  if (hasFind && (args.find.length === 0 || (args.all !== undefined && typeof args.all !== 'boolean'))) {
    throw invalid('find must be non-empty and all must be boolean');
  }
  return hasStart ? validateLineEdit(paths, args, receipts) : validateExactEdit(paths, args, receipts);
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

async function validateLineEdit(paths, args, receipts) {
  const startLine = args.start_line;
  const endLine = args.end_line ?? startLine;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
    || startLine < 1 || endLine < startLine || endLine - startLine >= 400) {
    throw invalid('line range must be ordered, positive, and at most 400 lines');
  }
  const coverage = { start: startLine, end: endLine };
  const { resolved, content, actual, receipt, transaction } = await editSnapshot(paths, args, receipts, coverage);
  const boundArgs = {
    path: args.path, edit_mode: 'lines', start_line: startLine, end_line: endLine,
    replacement: args.content, expected_sha256: receipt?.digest ?? transaction?.digest,
  };
  const prepared = receipt
    ? prepareLineEdit(receipts, resolved.path, boundArgs, content, actual)
    : { startLine, endLine, recovered: false, expectedSha256: actual };
  const lines = logicalLines(content);
  if (prepared.endLine > lines.length) throw new ContractError('edit_line_out_of_range', 'line range exceeds the file snapshot');
  const selected = lines.slice(prepared.startLine - 1, prepared.endLine).join('\n');
  const updated = replaceLineRange(content, prepared.startLine, prepared.endLine, args.content);
  assertUpdatedBound(updated);
  return preparedEdit(resolved, receipt, transaction, prepared, {
    ...boundArgs, start_line: prepared.startLine, end_line: prepared.endLine,
    selected_sha256: sha256(selected),
  }, updated, content, 'line_range_edit');
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
  const updated = prepared.request.args.edit_mode === 'lines'
    ? executeLineReplacement(prepared.request, content) : executeExactReplacement(prepared.request, content);
  const replacements = prepared.request.args.edit_mode === 'lines'
    ? prepared.request.args.end_line - prepared.request.args.start_line + 1
    : prepared.request.args.replace_all ? countOccurrences(content, prepared.request.args.old_text) : 1;
  const result = await atomicWrite({ ...prepared.request, args: { ...prepared.request.args, content: updated } }, signal, {
    message: prepared.request.args.edit_mode === 'lines' ? 'line edit completed' : 'edit completed', replacements,
  }, changes);
  receipts.recordAuthored(prepared.request.resolved.path, sha256(updated), updated);
  return withAuthoredAdvanceMetadata(result, prepared.advanced);
}

function executeLineReplacement(request, content) {
  const lines = logicalLines(content);
  if (request.args.end_line > lines.length) throw drift('edit line range changed after review');
  const selected = lines.slice(request.args.start_line - 1, request.args.end_line).join('\n');
  if (sha256(selected) !== request.args.selected_sha256) throw drift('edit line range changed after review');
  return replaceLineRange(content, request.args.start_line, request.args.end_line, request.args.replacement);
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
