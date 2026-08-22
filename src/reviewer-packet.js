// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

export function safeReviewRequest(request, outsideWorkspace) {
  return Object.freeze({
    id: request.id, toolName: request.toolName, args: safeArguments(request.args),
    resolvedTarget: request.resolved.path ?? request.resolved.source?.path ?? request.resolved.destination?.path ?? 'external',
    scope: outsideWorkspace ? 'host' : (request.resolved.path || request.resolved.source?.path ? 'workspace' : 'external'),
    caller: request.caller, mutationEvidence: safeMutationEvidence(request.resolved?.mutationEvidence),
  });
}

export function safeReviewDefinition(definition) {
  return Object.freeze({
    name: definition.name,
    purpose: typeof definition.purpose === 'string' ? definition.purpose.slice(0, 4096) : '',
    sideEffect: definition.sideEffect,
    scope: definition.scope,
    source: typeof definition.source === 'string' ? definition.source : 'built_in',
  });
}

function safeMutationEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.freeze({
    operation: value.operation, before_sha256: value.before_sha256, after_sha256: value.after_sha256,
    before_bytes: value.before_bytes, after_bytes: value.after_bytes,
  });
}

function safeArguments(args) {
  if (args.edit_mode === 'lines' && typeof args.replacement === 'string') {
    return Object.freeze({
      path: args.path, expected_sha256: args.expected_sha256,
      start_line: args.start_line, end_line: args.end_line,
      replacement_bytes: Buffer.byteLength(args.replacement, 'utf8'), replacement_sha256: digest(args.replacement),
    });
  }
  if (typeof args.old_text === 'string' && typeof args.new_text === 'string') {
    return Object.freeze({
      path: args.path, expected_sha256: args.expected_sha256, replace_all: args.replace_all === true,
      old_text_bytes: Buffer.byteLength(args.old_text, 'utf8'), old_text_sha256: digest(args.old_text),
      new_text_bytes: Buffer.byteLength(args.new_text, 'utf8'), new_text_sha256: digest(args.new_text),
    });
  }
  if (!Object.hasOwn(args, 'content') || typeof args.content !== 'string') return redactReviewValue(args);
  return Object.freeze({
    path: args.path, expected_sha256: args.expected_sha256,
    content_bytes: Buffer.byteLength(args.content, 'utf8'), content_sha256: digest(args.content),
  });
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function redactReviewValue(value, key = '') {
  if (/token|secret|password|credential|api.?key/iu.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return /(?:bearer\s+|api[_-]?key\s*[=:]|token\s*[=:]|password\s*[=:])/iu.test(value) ? '[redacted]' : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactReviewValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactReviewValue(item, name)]));
  }
  return value;
}
