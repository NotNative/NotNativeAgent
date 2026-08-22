// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';
import { providerReasoningControls } from '../provider/reasoning.js';

const TOKEN_BYTE_RATIO = 3;
const MAX_SECTIONS = 64;

export function measureProviderEnvelope(request, context = [], options = {}) {
  validateRequest(request);
  const messages = request.messages ?? [];
  const injectedCount = Math.max(0, messages.length - context.length);
  const sections = new Map();
  for (let index = 0; index < messages.length; index += 1) {
    const provenance = index < injectedCount ? 'request.injected_system'
      : `context.${sectionLabel(context[index - injectedCount]?.provenance)}`;
    addSection(sections, provenance, messages[index]);
  }
  addSection(sections, 'request.framing', { messages: [], tools: [] });
  addSection(sections, 'request.tool_schemas', request.tools ?? []);
  addSection(sections, 'request.configuration', requestConfiguration(request));
  const inventory = boundedInventory(sections);
  const inputTokens = inventory.reduce((total, item) => total + item.estimated_tokens, 0);
  const outputReserve = positiveInteger(options.outputReserveTokens) ?? 0;
  return Object.freeze({
    schema: 'nna.provider-envelope.v1', measurement: 'estimated',
    estimator: 'serialized_utf8_bytes_div_3_v1',
    estimated_input_tokens: inputTokens,
    reserved_output_tokens: outputReserve,
    reserved_total_tokens: inputTokens + outputReserve,
    configured_output_limit_tokens: positiveInteger(request.maxOutputTokens),
    configuration: providerConfiguration(request),
    shape: providerRequestShape(request),
    sections: Object.freeze(inventory),
  });
}

export function assertProviderEnvelopeFits(envelope, budget) {
  if (!envelope || envelope.schema !== 'nna.provider-envelope.v1') {
    throw new ContractError('provider_envelope_invalid', 'provider envelope measurement is invalid');
  }
  if (positiveInteger(budget?.scaledTokens) && envelope.estimated_input_tokens > budget.scaledTokens) {
    throw new ContractError('context_too_large', 'complete provider request exceeds conservative input threshold');
  }
  if (positiveInteger(budget?.windowTokens) && envelope.reserved_total_tokens > budget.windowTokens) {
    throw new ContractError('context_too_large', 'complete provider request plus output reserve exceeds model context window');
  }
  return true;
}

export function createProviderTokenReceipt(manifest, active, detail = {}) {
  const reported = normalizedUsage(detail.usage);
  const estimatedInput = manifest?.envelope?.estimated_input_tokens ?? null;
  const estimatedOutput = estimateBytes(detail.outputBytes ?? 0);
  const accounting = reconcile(reported, estimatedInput, estimatedOutput);
  const core = {
    schema: 'nna.provider-token-receipt.v1', turn_id: active?.turnId ?? null,
    step_id: active?.stepId ?? null, attempt_id: detail.attemptId ?? active?.attemptId ?? null,
    logical_request_id: detail.logicalRequestId ?? active?.logicalRequestId ?? null,
    role: detail.role ?? 'primary',
    provider_profile: detail.providerProfile ?? active?.providerResource ?? null,
    model: detail.model ?? active?.modelName ?? null,
    request_fingerprint: manifest?.requestFingerprint ?? null,
    outcome: detail.outcome ?? 'failed', reason_code: detail.reasonCode ?? null,
    duration_ms: finiteNonnegative(detail.durationMs), dispatch: 'attempted',
    envelope: manifest?.envelope ?? null, reported_usage: reported, accounting,
  };
  return Object.freeze({
    ...core, receipt_id: digest(core), recorded_at: new Date().toISOString(),
  });
}

export function aggregateTokenReceipts(receipts = []) {
  const valid = receipts.filter((item) => item?.schema === 'nna.provider-token-receipt.v1');
  const totals = valid.reduce((result, item) => {
    const value = item.accounting ?? {};
    result.measured += value.measured_total_tokens ?? 0;
    result.estimated += value.estimated_unreported_tokens ?? 0;
    result.input += value.accounted_input_tokens ?? 0;
    result.output += value.accounted_output_tokens ?? 0;
    result.measuredAttempts += value.measurement === 'provider' ? 1 : 0;
    result.estimatedAttempts += value.measurement === 'estimated' ? 1 : 0;
    result.mixedAttempts += value.measurement === 'mixed' ? 1 : 0;
    return result;
  }, { measured: 0, estimated: 0, input: 0, output: 0, measuredAttempts: 0, estimatedAttempts: 0, mixedAttempts: 0 });
  return Object.freeze({
    schema: 'nna.token-accounting.v1', attempts: valid.length,
    measured_attempts: totals.measuredAttempts, estimated_attempts: totals.estimatedAttempts,
    mixed_attempts: totals.mixedAttempts, measured_total_tokens: totals.measured,
    estimated_unreported_tokens: totals.estimated,
    accounted_input_tokens: totals.input, accounted_output_tokens: totals.output,
    accounted_total_tokens: totals.measured + totals.estimated,
    measurement: aggregateMeasurement(totals),
    by_role: roleAccounting(valid),
  });
}

export function combineTokenAccounting(summaries = []) {
  const valid = summaries.filter((item) => item?.schema === 'nna.token-accounting.v1');
  const fields = [
    'attempts', 'measured_attempts', 'estimated_attempts', 'mixed_attempts',
    'measured_total_tokens', 'estimated_unreported_tokens',
    'accounted_input_tokens', 'accounted_output_tokens', 'accounted_total_tokens',
  ];
  const result = { schema: 'nna.token-accounting.v1' };
  for (const key of fields) result[key] = valid.reduce((total, item) => total + (item[key] ?? 0), 0);
  result.measurement = result.estimated_unreported_tokens > 0
    ? (result.measured_total_tokens > 0 ? 'mixed' : 'estimated')
    : result.measured_total_tokens > 0 ? 'provider' : 'unavailable';
  result.by_role = mergeRoleAccounting(valid.map((item) => item.by_role));
  return Object.freeze(result);
}

function roleAccounting(receipts) {
  const roles = {};
  for (const receipt of receipts) {
    const role = sectionLabel(receipt.role ?? 'primary');
    const current = roles[role] ?? { attempts: 0, measured_total_tokens: 0, estimated_unreported_tokens: 0 };
    current.attempts += 1;
    current.measured_total_tokens += receipt.accounting?.measured_total_tokens ?? 0;
    current.estimated_unreported_tokens += receipt.accounting?.estimated_unreported_tokens ?? 0;
    roles[role] = current;
  }
  return Object.freeze(Object.fromEntries(Object.entries(roles).map(([key, value]) => [key, Object.freeze({
    ...value, accounted_total_tokens: value.measured_total_tokens + value.estimated_unreported_tokens,
  })])));
}

function mergeRoleAccounting(values) {
  const roles = {};
  for (const value of values.filter(Boolean)) for (const [role, accounting] of Object.entries(value)) {
    const current = roles[role] ?? { attempts: 0, measured_total_tokens: 0, estimated_unreported_tokens: 0 };
    for (const key of Object.keys(current)) current[key] += accounting[key] ?? 0;
    roles[role] = current;
  }
  return Object.freeze(Object.fromEntries(Object.entries(roles).map(([key, value]) => [key, Object.freeze({
    ...value, accounted_total_tokens: value.measured_total_tokens + value.estimated_unreported_tokens,
  })])));
}

function reconcile(reported, estimatedInput, estimatedOutput) {
  const measuredInput = reported?.input_tokens ?? null;
  const measuredOutput = reported?.output_tokens ?? null;
  const providerTotal = reported?.total_tokens ?? sumKnown(measuredInput, measuredOutput);
  const input = measuredInput ?? estimatedInput ?? 0;
  const output = measuredOutput ?? estimatedOutput;
  const measuredPortion = providerTotal ?? (measuredInput ?? 0) + (measuredOutput ?? 0);
  const estimatedMissing = providerTotal !== null ? 0
    : (measuredInput === null ? input : 0) + (measuredOutput === null ? output : 0);
  const measurement = providerTotal !== null ? 'provider'
    : measuredInput !== null || measuredOutput !== null ? 'mixed' : 'estimated';
  return Object.freeze({
    measurement, accounted_input_tokens: input, accounted_output_tokens: output,
    accounted_total_tokens: providerTotal ?? measuredPortion + estimatedMissing,
    measured_total_tokens: measuredPortion,
    estimated_unreported_tokens: estimatedMissing,
  });
}

function normalizedUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const input = firstInteger(usage, ['prompt_tokens', 'input_tokens', 'inputTokens']);
  const output = firstInteger(usage, ['completion_tokens', 'output_tokens', 'outputTokens']);
  const total = firstInteger(usage, ['total_tokens', 'totalTokens']);
  if (input === null && output === null && total === null) return null;
  return Object.freeze({ input_tokens: input, output_tokens: output, total_tokens: total });
}

function addSection(sections, id, value) {
  const bytes = serializedBytes(value);
  const current = sections.get(id) ?? { bytes: 0, tokens: 0, items: 0 };
  current.bytes += bytes; current.tokens += estimateBytes(bytes); current.items += 1;
  sections.set(id, current);
}

function boundedInventory(sections) {
  const entries = [...sections.entries()];
  if (entries.length <= MAX_SECTIONS) return Object.freeze(entries.map(inventoryItem));
  const retained = entries.slice(0, MAX_SECTIONS - 1).map(inventoryItem);
  const overflow = entries.slice(MAX_SECTIONS - 1).reduce((total, [, value]) => ({
    bytes: total.bytes + value.bytes, tokens: total.tokens + value.tokens, items: total.items + value.items,
  }), { bytes: 0, tokens: 0, items: 0 });
  return Object.freeze([...retained, inventoryItem(['context.other', overflow])]);
}

function inventoryItem([id, value]) {
  return Object.freeze({ id, bytes: value.bytes, estimated_tokens: value.tokens, items: value.items });
}

function requestConfiguration(request) {
  const { messages: _messages, tools: _tools, ...configuration } = request;
  return configuration;
}

function providerConfiguration(request) {
  const reasoning = providerReasoningControls(request);
  const effortSent = Object.hasOwn(reasoning, 'reasoning_effort');
  const thinkingSent = typeof reasoning.chat_template_kwargs?.enable_thinking === 'boolean';
  return Object.freeze({
    temperature: fieldState(Number.isFinite(request.temperature), request.temperature),
    max_output_tokens: fieldState(positiveInteger(request.maxOutputTokens) !== null, positiveInteger(request.maxOutputTokens)),
    reasoning_effort: fieldState(effortSent, reasoning.reasoning_effort),
    enable_thinking: fieldState(thinkingSent, reasoning.chat_template_kwargs?.enable_thinking),
    reasoning_mode: fieldState(typeof request.reasoningMode === 'string', request.reasoningMode),
    tool_choice: request.tools.length > 0 ? 'auto' : null,
  });
}

function fieldState(sent, value) {
  return Object.freeze({ sent, value: sent ? value : null });
}

function providerRequestShape(request) {
  const roles = {};
  let assistantToolCallMessages = 0; let toolCalls = 0; let maxToolCallsPerMessage = 0;
  for (const message of request.messages) {
    const role = sectionLabel(message?.role ?? 'unknown');
    roles[role] = (roles[role] ?? 0) + 1;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
    if (calls > 0) assistantToolCallMessages += 1;
    toolCalls += calls; maxToolCallsPerMessage = Math.max(maxToolCallsPerMessage, calls);
  }
  const tools = request.tools.slice(0, 128).map((tool) => Object.freeze({
    name: boundedToolName(tool?.function?.name), schema_bytes: serializedBytes(tool),
  }));
  return Object.freeze({
    message_count: request.messages.length,
    message_roles: Object.freeze(roles),
    assistant_tool_call_messages: assistantToolCallMessages,
    tool_call_count: toolCalls,
    max_tool_calls_per_message: maxToolCallsPerMessage,
    tool_schema_count: request.tools.length,
    tool_schema_bytes: request.tools.reduce((total, tool) => total + serializedBytes(tool), 0),
    tools: Object.freeze(tools),
  });
}

function boundedToolName(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : 'unnamed';
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages)
    || !Array.isArray(request.tools ?? [])) {
    throw new ContractError('provider_envelope_invalid', 'provider envelope requires messages and tools');
  }
}

function sectionLabel(value) {
  const label = typeof value === 'string' ? value : 'unattributed';
  return label.split(':', 1)[0].replace(/[^a-z0-9_.-]/giu, '_').slice(0, 64) || 'unattributed';
}

function serializedBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'); }
  catch { throw new ContractError('provider_envelope_invalid', 'provider envelope contains a non-JSON value'); }
}
function estimateBytes(bytes) { return Math.ceil(Math.max(0, bytes) / TOKEN_BYTE_RATIO); }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function finiteNonnegative(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
function firstInteger(value, keys) { return keys.map((key) => value[key]).find(Number.isSafeInteger) ?? null; }
function sumKnown(left, right) { return left !== null && right !== null ? left + right : null; }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function aggregateMeasurement(value) {
  if (value.estimated === 0 && value.mixedAttempts === 0) return value.measuredAttempts > 0 ? 'provider' : 'unavailable';
  if (value.measured === 0 && value.mixedAttempts === 0) return 'estimated';
  return 'mixed';
}
