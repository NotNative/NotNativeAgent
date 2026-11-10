// SPDX-License-Identifier: Apache-2.0
import { sha256Hex } from './digests.js';

export function safeReviewRequest(request, outsideWorkspace) {
  const process = ['shell_run', 'process_run'].includes(request.toolName);
  const resolved = request.resolved ?? {};
  // Why the destination and method travel with the packet: for a network request
  // the reviewer must judge where the data goes, not only which tool ran. An
  // agent that reaches a page or posts to it can carry workspace content out.
  const destination = safeDestination(resolved.destination);
  return Object.freeze({
    id: request.id, toolName: request.toolName, args: safeArguments(request.toolName, request.args),
    // Security: a process working directory is not a ceiling on paths named by its command.
    resolvedTarget: process ? 'unresolved_process_effects'
      : resolved.path ?? resolved.source?.path ?? resolved.destination?.path ?? resolved.destination ?? 'external',
    ...(process ? { workingDirectory: resolved.path ?? null } : {}),
    scope: process || outsideWorkspace ? 'host'
      : (resolved.path || resolved.source?.path || resolved.destination?.path ? 'workspace' : 'external'),
    caller: request.caller, mutationEvidence: safeMutationEvidence(resolved.mutationEvidence),
    ...(typeof resolved.method === 'string' ? { method: resolved.method } : {}),
    ...(destination ? { destination } : {}),
  });
}

/** The destination as the reviewer sees it: scheme, host, and path, with any
 * user info, query, and fragment left out so a credential in a URL is never
 * copied into a review packet. */
export function safeDestination(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let parsed;
  try { parsed = new URL(value); } catch {
    return value.length <= 2048 ? Object.freeze({ raw: value.slice(0, 2048) }) : null;
  }
  return Object.freeze({
    origin: parsed.origin, path: parsed.pathname.slice(0, 2048),
    ...(parsed.port ? { port: parsed.port } : {}),
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

function safeArguments(toolName, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return Object.freeze({});
  if (toolName === 'fs_edit_lines' && typeof args.replacement === 'string') {
    return Object.freeze({
      path: args.path, expected_sha256: args.expected_sha256,
      start_line: args.start_line, end_line: args.end_line,
      replacement_bytes: Buffer.byteLength(args.replacement, 'utf8'), replacement_sha256: sha256Hex(args.replacement),
    });
  }
  if (toolName === 'fs_edit_text' && typeof args.old_text === 'string' && typeof args.new_text === 'string') {
    return Object.freeze({
      path: args.path, expected_sha256: args.expected_sha256, replace_all: args.replace_all === true,
      old_text_bytes: Buffer.byteLength(args.old_text, 'utf8'), old_text_sha256: sha256Hex(args.old_text),
      new_text_bytes: Buffer.byteLength(args.new_text, 'utf8'), new_text_sha256: sha256Hex(args.new_text),
    });
  }
  const safe = redactReviewValue(args);
  if (typeof args.content === 'string') {
    delete safe.content;
    safe.content_bytes = Buffer.byteLength(args.content, 'utf8');
    safe.content_sha256 = sha256Hex(args.content);
  }
  return Object.freeze(safe);
}

function redactReviewValue(value, key = '') {
  if (/token|secret|password|credential|api.?key|authorization/iu.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return /(?:bearer\s+|authorization\s*:|api[_-]?key\s*[=:]|token\s*[=:]|password\s*[=:]|--?(?:[\w-]*[-_])?(?:token|api[-_]?key|password|secret|credential|authorization|auth)\s+)/iu.test(value)
      ? '[redacted]' : value;
  }
  if (Array.isArray(value)) {
    const safe = value.map((item) => redactReviewValue(item));
    // process_run seals its argument vector as args.args; external tools may call it argv.
    if (key === 'args' || key === 'argv') {
      for (let index = 0; index < value.length - 1; index += 1) {
        if (typeof value[index] === 'string' && /^--?(?:[\w-]*[-_])?(?:token|api[-_]?key|password|secret|credential|authorization|auth)$/iu.test(value[index])) {
          safe[index + 1] = '[redacted]';
        }
      }
    }
    return safe;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactReviewValue(item, name)]));
  }
  return value;
}
