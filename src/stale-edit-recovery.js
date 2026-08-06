// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function prepareTextEdit(receipts, path, args, current, actualDigest) {
  let recovered = false;
  if (actualDigest !== args.expected_sha256) {
    const snapshot = receipts.contentFor(path, args.expected_sha256, { full: true });
    requireMatch(snapshot, args);
    recovered = true;
  }
  const occurrences = requireMatch(current, args);
  return Object.freeze({ occurrences, recovered, expectedSha256: actualDigest });
}

export function prepareLineEdit(receipts, path, args, current, actualDigest) {
  if (actualDigest === args.expected_sha256) {
    return Object.freeze({ startLine: args.start_line, endLine: args.end_line, recovered: false, expectedSha256: actualDigest });
  }
  const snapshot = receipts.contentFor(path, args.expected_sha256, { start: args.start_line, end: args.end_line });
  const before = logicalLines(snapshot); const live = logicalLines(current);
  if (args.end_line > before.length) throw new ContractError('edit_line_out_of_range', 'line range exceeds the read snapshot');
  const anchorStart = Math.max(1, args.start_line - 1);
  const anchorEnd = Math.min(before.length, args.end_line + 1);
  const anchor = before.slice(anchorStart - 1, anchorEnd);
  const matches = [];
  for (let index = 0; index <= live.length - anchor.length; index += 1) {
    if (anchor.every((line, offset) => live[index + offset] === line)) matches.push(index + 1);
  }
  if (matches.length !== 1) {
    throw new ContractError('tool_revalidation_drift', 'edited lines no longer map uniquely into the live file; read the file again');
  }
  const offset = matches[0] - anchorStart;
  return Object.freeze({
    startLine: args.start_line + offset, endLine: args.end_line + offset,
    recovered: true, expectedSha256: actualDigest,
  });
}

function requireMatch(content, args) {
  const occurrences = countOccurrences(content, args.old_text);
  if (occurrences === 0) throw new ContractError('edit_match_missing', 'old_text was not found in the read snapshot');
  if (!args.replace_all && occurrences !== 1) {
    throw new ContractError('edit_match_ambiguous', 'old_text occurs more than once; provide more context or use replace_all');
  }
  if (occurrences > 4096) throw new ContractError('edit_match_limit', 'edit exceeds the replacement-count bound');
  return occurrences;
}

function countOccurrences(content, search) {
  let count = 0; let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) { count += 1; offset += search.length; }
  return count;
}

function logicalLines(content) {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.length > 0 ? lines : [''];
}
