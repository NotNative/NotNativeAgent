// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactText } from '../redaction.js';

const SUMMARY_BYTES = Object.freeze({ filesystem: 768, search: 1024, shell: 1024, web: 1024, mcp: 1024, subagent: 1536, other: 768 });

export function createToolContextReceipt(result, request) {
  const category = toolCategory(result.toolName ?? request?.toolName);
  const target = toolTarget(request, category);
  const receipt = Object.freeze({
    schema: 'nna.tool-receipt.v1', tool: result.toolName ?? request?.toolName ?? 'unknown',
    category, target, outcome: result.status ?? 'unknown',
    effect_certainty: result.effectCertainty ?? result.effect_certainty ?? 'unknown',
    reason_code: result.reasonCode ?? result.reason_code ?? null,
    summary: boundedHeadTail(redactText(String(result.content ?? '')), SUMMARY_BYTES[category]),
    result_fingerprint: resultFingerprint(result), ledger_ref: ledgerReference(result),
  });
  return {
    ...result, content: JSON.stringify(receipt),
    metadata: {
      ...boundedMetadata(result.metadata), compacted: true, reason: 'semantic_tool_receipt',
      originalReason: result.metadata?.reason ?? null, ledgerRef: receipt.ledger_ref,
      resultFingerprint: receipt.result_fingerprint, receiptSchema: receipt.schema,
    },
  };
}

export function compactToolRequest(request) {
  if (!request?.args || typeof request.args !== 'object') return request;
  const category = toolCategory(request.toolName);
  return { ...request, args: compactArgs(request.args, category, request.toolName) };
}

function compactArgs(args, category, toolName) {
  const target = toolTarget({ args, toolName }, category);
  if (category === 'filesystem' || category === 'search') return filesystemArgs(args, target);
  if (category === 'shell') return shellArgs(args, toolName);
  if (category === 'web') return { url: bounded(args.url ?? args.endpoint ?? target, 512), method: bounded(args.method ?? 'GET', 16) };
  if (category === 'mcp') return { target, argument_keys: Object.keys(args).slice(0, 32) };
  if (category === 'subagent') return { target, task: bounded(args.task ?? args.prompt ?? args.objective ?? '', 512) };
  return { target, argument_keys: Object.keys(args).slice(0, 32) };
}

function shellArgs(args, toolName) {
  if (toolName === 'shell.run') return {
    script: bounded(args.script ?? '', 768), shell: args.shell ?? 'auto',
    ...(args.cwd ? { cwd: bounded(args.cwd, 512) } : {}), ...(args.timeout_ms ? { timeout_ms: args.timeout_ms } : {}),
  };
  return {
    executable: bounded(args.executable ?? '', 128),
    args: Array.isArray(args.args) ? args.args.slice(0, 32).map((value) => bounded(value, 128)) : [],
    ...(args.cwd ? { cwd: bounded(args.cwd, 512) } : {}), ...(args.timeout_ms ? { timeout_ms: args.timeout_ms } : {}),
  };
}

function filesystemArgs(args, target) {
  const result = { path: target };
  for (const key of ['query', 'pattern', 'glob', 'start_line', 'end_line', 'depth']) {
    if (args[key] !== undefined) result[key] = typeof args[key] === 'string' ? bounded(args[key], 256) : args[key];
  }
  return result;
}

function toolCategory(name = '') {
  if (/^(?:fs\.|code\.)/u.test(name)) return /(?:search|glob|list|diagnostic)/u.test(name) ? 'search' : 'filesystem';
  if (/^(?:process\.|shell\.)/u.test(name)) return 'shell';
  if (/^web\./u.test(name)) return 'web';
  if (/^mcp\./u.test(name)) return 'mcp';
  if (/^(?:agent\.|subagent\.)/u.test(name)) return 'subagent';
  return 'other';
}

function toolTarget(request, category) {
  const args = request?.args ?? {};
  if (category === 'filesystem' || category === 'search') return bounded(args.path ?? args.cwd ?? '.', 512);
  if (category === 'shell') return bounded(commandText(args), 768);
  if (category === 'web') return bounded(args.url ?? args.endpoint ?? '', 512);
  if (category === 'mcp') return bounded(args.uri ?? args.resource ?? args.id ?? request?.toolName ?? '', 512);
  if (category === 'subagent') return bounded(args.role ?? args.name ?? args.model ?? 'subagent', 256);
  return bounded(args.path ?? args.id ?? args.name ?? request?.toolName ?? '', 512);
}

function commandText(args) {
  if (typeof args.command === 'string') return args.command;
  return [args.executable, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' ');
}

function resultFingerprint(result) {
  return createHash('sha256').update(JSON.stringify({
    tool: result.toolName, status: result.status, content: result.content,
    effect: result.effectCertainty ?? result.effect_certainty, reason: result.reasonCode ?? result.reason_code,
  })).digest('hex');
}

function ledgerReference(item) { return item.requestId ?? item.providerCallId ?? item.turnId ?? item.turn_id ?? null; }

function boundedMetadata(value) {
  if (value === null || value === undefined) return value ?? null;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2_048 ? value : { compacted: true }; }
  catch { return { compacted: true }; }
}

function bounded(value, maxBytes) { return boundedHeadTail(redactText(String(value ?? '')), maxBytes); }

function boundedHeadTail(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  const marker = '\n...[middle omitted]...\n'; const available = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const head = buffer.subarray(0, Math.ceil(available * 0.7)).toString('utf8').replace(/\uFFFD$/u, '');
  const tail = buffer.subarray(buffer.length - Math.floor(available * 0.3)).toString('utf8').replace(/^\uFFFD/u, '');
  return `${head}${marker}${tail}`;
}
