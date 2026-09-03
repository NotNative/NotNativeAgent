// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';
import { redactText } from '../redaction.js';
import { toolLifecycleStatus } from './tool-result-contract.js';

// Why: filesystem evidence is frequently consumed across several reasoning steps; retaining
// a useful window is cheaper than forcing another provider/tool round trip after compaction.
const EXCERPT_BYTES = Object.freeze({ filesystem: 4096, search: 2048, shell: 1024, web: 1024, mcp: 1024, subagent: 1536, other: 768 });
const RECEIPT_SCHEMA = 'nna.tool-receipt.v2';
const OMISSION_MARKER = '\n...[middle omitted]...\n';
const ESSENTIAL_METADATA = Object.freeze([
  'exitCode', 'signal', 'acceptedExitCodes', 'timedOut', 'diagnosticOutcome',
  'observation_outcome', 'target_exists', 'matches', 'bytesObserved', 'outputLimitBytes',
]);

export function createToolContextReceipt(result, request) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ContractError('tool_result_invalid', 'a structured tool result is required');
  }
  const category = toolCategory(result.toolName ?? request?.toolName);
  const target = toolTarget(request, category);
  const prior = existingReceipt(result);
  const redactedContent = safeRedact(result.content);
  const projection = headTailProjection(redactedContent, EXCERPT_BYTES[category]);
  const excerpt = prior?.excerpt ?? projection.excerpt;
  const originalBytes = prior?.projection?.original_bytes ?? result.metadata?.originalBytes ?? Buffer.byteLength(redactedContent, 'utf8');
  const excerptBytes = Buffer.byteLength(excerpt, 'utf8');
  const retainedBytes = prior ? result.metadata?.retainedSourceBytes ?? excerptBytes
    : excerpt === redactedContent ? excerptBytes : Math.max(0, excerptBytes - Buffer.byteLength(OMISSION_MARKER));
  const ranges = prior ? result.metadata?.omittedRanges : !result.truncated && !result.metadata?.contentRedacted
    && redactedContent === result.content && originalBytes === Buffer.byteLength(redactedContent) ? projection.omittedRanges : undefined;
  const receipt = Object.freeze({
    schema: RECEIPT_SCHEMA, tool: result.toolName ?? request?.toolName ?? prior?.tool ?? 'unknown',
    category: prior?.category ?? category, target: prior?.target ?? target,
    outcome: toolLifecycleStatus(result) ?? prior?.outcome ?? 'unknown',
    effect_certainty: result.effectCertainty ?? result.effect_certainty ?? prior?.effect_certainty ?? 'unknown',
    reason_code: result.reasonCode ?? result.reason_code ?? prior?.reason_code ?? null,
    excerpt,
    result_fingerprint: prior?.result_fingerprint ?? resultFingerprint(result),
    ledger_ref: prior?.ledger_ref ?? ledgerReference(result),
  });
  const content = JSON.stringify(receipt);
  return {
    ...result, content,
    metadata: {
      ...boundedMetadata(result.metadata), compacted: true, reason: 'bounded_tool_receipt',
      originalReason: result.metadata?.reason ?? null, ledgerRef: receipt.ledger_ref,
      resultFingerprint: receipt.result_fingerprint, receiptSchema: receipt.schema,
      originalBytes, projectedBytes: Buffer.byteLength(content, 'utf8'),
      retainedSourceBytes: retainedBytes, omittedBytes: Math.max(0, originalBytes - retainedBytes),
      projectionReason: 'bounded_tool_receipt',
      ...(ranges?.length ? { omittedRanges: ranges, rangeBasis: 'tool_content_utf8' } : {}),
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
  if (typeof args.script === 'string') return args.script;
  if (typeof args.command === 'string') return args.command;
  return [args.executable, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' ');
}

function resultFingerprint(result) {
  const fields = {
    tool: result.toolName, toolLifecycleStatus: toolLifecycleStatus(result), content: result.content,
    effect: result.effectCertainty ?? result.effect_certainty,
    reason: result.reasonCode ?? result.reason_code,
  };
  let serialized;
  try { serialized = JSON.stringify(fields); }
  catch {
    serialized = JSON.stringify({
      tool: typeof fields.tool === 'string' ? fields.tool : '[unknown]',
      toolLifecycleStatus: typeof fields.toolLifecycleStatus === 'string' ? fields.toolLifecycleStatus : '[unknown]',
      content: '[unserializable]',
    });
  }
  return createHash('sha256').update(serialized ?? '[undefined]').digest('hex');
}

function existingReceipt(result) {
  if (![RECEIPT_SCHEMA, 'nna.tool-receipt.v1'].includes(result.metadata?.receiptSchema)) return null;
  let receipt = parseReceipt(result.content);
  if (!receipt) return null;
  for (let depth = 0; depth < 256; depth += 1) {
    const nested = parseReceipt(receipt.excerpt);
    if (!nested) break;
    receipt = {
      ...receipt,
      excerpt: nested.excerpt,
      result_fingerprint: nested.result_fingerprint ?? receipt.result_fingerprint,
      ledger_ref: nested.ledger_ref ?? receipt.ledger_ref,
    };
  }
  return receipt;
}

function parseReceipt(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.schema === RECEIPT_SCHEMA && typeof parsed.excerpt === 'string') return parsed;
    // Why: old durable receipts remain evidence, but new provider output never calls an excerpt a summary.
    if (parsed.schema === 'nna.tool-receipt.v1' && typeof parsed.summary === 'string') return { ...parsed, excerpt: parsed.summary };
    return null;
  } catch { return null; }
}

function ledgerReference(item) { return item.requestId ?? item.providerCallId ?? item.turnId ?? item.turn_id ?? null; }

function boundedMetadata(value) {
  if (value === null || value === undefined) return value ?? null;
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2_048) return value;
    const retained = Object.fromEntries(ESSENTIAL_METADATA.filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]));
    return { ...retained, compacted: true, omittedMetadata: true };
  }
  catch { return { compacted: true }; }
}

function bounded(value, maxBytes) { return boundedHeadTail(safeRedact(value), maxBytes); }

function boundedHeadTail(value, maxBytes) {
  return headTailProjection(value, maxBytes).excerpt;
}

function headTailProjection(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return { excerpt: value, omittedRanges: [] };
  const marker = OMISSION_MARKER;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) return { excerpt: takePrefixBytes(marker, maxBytes), omittedRanges: [] };
  const available = maxBytes - markerBytes;
  const headBudget = Math.ceil(available * 0.7);
  const head = takePrefixBytes(value, headBudget);
  const tail = takeSuffixBytes(value, available - Buffer.byteLength(head, 'utf8'));
  // Why: offsets describe the exact UTF-8 tool content, never file lines or bytes removed by redaction.
  return { excerpt: `${head}${marker}${tail}`, omittedRanges: [{
    start_byte: Buffer.byteLength(head), end_byte_exclusive: buffer.byteLength - Buffer.byteLength(tail),
  }] };
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
