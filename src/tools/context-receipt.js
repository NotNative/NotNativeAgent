// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';
import { redactText } from '../redaction.js';

const SUMMARY_BYTES = Object.freeze({ filesystem: 768, search: 1024, shell: 1024, web: 1024, mcp: 1024, subagent: 1536, other: 768 });

export function createToolContextReceipt(result, request) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ContractError('tool_result_invalid', 'a structured tool result is required');
  }
  const category = toolCategory(result.toolName ?? request?.toolName);
  const target = toolTarget(request, category);
  const receipt = Object.freeze({
    schema: 'nna.tool-receipt.v1', tool: result.toolName ?? request?.toolName ?? 'unknown',
    category, target, outcome: result.status ?? 'unknown',
    effect_certainty: result.effectCertainty ?? result.effect_certainty ?? 'unknown',
    reason_code: result.reasonCode ?? result.reason_code ?? null,
    summary: boundedHeadTail(safeRedact(result.content), SUMMARY_BYTES[category]),
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

function toolCategory(name = '') {
  if (/^(?:fs\.|code\.)/u.test(name)) return /(?:search|glob|list|diagnostic)/u.test(name) ? 'search' : 'filesystem';
  if (/^(?:process\.|shell\.)/u.test(name)) return 'shell';
  if (/^web\./u.test(name)) return 'web';
  if (/^mcp\./u.test(name)) return 'mcp';
  if (/^(?:agent\.|subagent\.)/u.test(name)) return 'subagent';
  return 'other';
}

function toolTarget(request, category) {
  const args = objectOrEmpty(request?.args);
  if (category === 'filesystem' || category === 'search') return bounded(args.path ?? args.cwd ?? '.', 512);
  if (category === 'shell') return bounded(commandText(args), 768);
  if (category === 'web') return bounded(args.url ?? args.endpoint ?? '', 512);
  if (category === 'mcp') return bounded(args.uri ?? args.resource ?? args.id ?? request?.toolName ?? '', 512);
  if (category === 'subagent') return bounded(args.role ?? args.name ?? args.model ?? 'subagent', 256);
  return bounded(args.path ?? args.id ?? args.name ?? request?.toolName ?? '', 512);
}

function commandText(args) {
  args = objectOrEmpty(args);
  if (typeof args.command === 'string') return args.command;
  return [args.executable, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' ');
}

function resultFingerprint(result) {
  const fields = {
    tool: result.toolName, status: result.status, content: result.content,
    effect: result.effectCertainty ?? result.effect_certainty,
    reason: result.reasonCode ?? result.reason_code,
  };
  let serialized;
  try { serialized = JSON.stringify(fields); }
  catch {
    serialized = JSON.stringify({
      tool: typeof fields.tool === 'string' ? fields.tool : '[unknown]',
      status: typeof fields.status === 'string' ? fields.status : '[unknown]',
      content: '[unserializable]',
    });
  }
  return createHash('sha256').update(serialized ?? '[undefined]').digest('hex');
}

function ledgerReference(item) { return item.requestId ?? item.providerCallId ?? item.turnId ?? item.turn_id ?? null; }

function boundedMetadata(value) {
  if (value === null || value === undefined) return value ?? null;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2_048 ? value : { compacted: true }; }
  catch { return { compacted: true }; }
}

function bounded(value, maxBytes) { return boundedHeadTail(safeRedact(value), maxBytes); }

function boundedHeadTail(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  const marker = '\n...[middle omitted]...\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) return takePrefixBytes(marker, maxBytes);
  const available = maxBytes - markerBytes;
  const headBudget = Math.ceil(available * 0.7);
  const head = takePrefixBytes(value, headBudget);
  const tail = takeSuffixBytes(value, available - Buffer.byteLength(head, 'utf8'));
  return `${head}${marker}${tail}`;
}

function takePrefixBytes(value, maximum) {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximum) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function takeSuffixBytes(value, maximum) {
  let bytes = 0;
  const result = [];
  for (let end = value.length; end > 0;) {
    let start = end - 1;
    const trailingCodeUnit = value.charCodeAt(start);
    if (trailingCodeUnit >= 0xDC00 && trailingCodeUnit <= 0xDFFF && start > 0) start -= 1;
    const character = value.slice(start, end);
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximum) break;
    result.push(character);
    bytes += characterBytes;
    end = start;
  }
  return result.reverse().join('');
}

function safeRedact(value) {
  try { return redactText(String(value ?? '')); }
  catch { return '[redaction failed]'; }
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
