// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { ToolCallAssembler } from '../reliability/tool-call-assembler.js';

const DEFAULT_QUALIFICATION_TIMEOUT_MS = 20_000;
const TEXT_PROBE_OUTPUT_TOKENS = 64;
const TOOL_PROBE_OUTPUT_TOKENS = 128;
const MAX_QUALIFICATION_OUTPUT_BYTES = 32_768;
const EXPECTED_QUALIFICATION_VALUE = 'NNA_OK';

export async function qualifyModel(provider, route, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUALIFICATION_TIMEOUT_MS;
  const text = await probe(provider, {
    model: route.model, temperature: 0, maxOutputTokens: TEXT_PROBE_OUTPUT_TOKENS, tools: [],
    messages: [{ role: 'system', content: 'This is a local compatibility check. Reply with exactly NNA_OK.' }],
  }, timeoutMs);
  const textPass = text.terminal && text.text.trim() === EXPECTED_QUALIFICATION_VALUE && text.calls.length === 0;
  const tool = await probe(provider, {
    model: route.model, temperature: 0, maxOutputTokens: TOOL_PROBE_OUTPUT_TOKENS,
    messages: [{ role: 'system', content: 'Call nna_qualification_echo exactly once with {"value":"NNA_OK"}. Do not answer in prose.' }],
    tools: [{ type: 'function', function: {
      name: 'nna_qualification_echo', description: 'Compatibility probe; no action is executed.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    } }],
  }, timeoutMs);
  const call = tool.calls.length === 1 ? tool.calls[0] : null;
  const toolPass = tool.terminal && tool.calls.length === 1 && call?.name === 'nna_qualification_echo'
    && call?.args?.value === EXPECTED_QUALIFICATION_VALUE;
  return Object.freeze({
    provider: route.profile.id, model: route.model,
    text: { passed: textPass, terminal: text.terminal, response: text.text.slice(0, 256) },
    tools: {
      passed: toolPass, terminal: tool.terminal, calls: tool.calls.length,
      parsed_name: call?.name ?? null, parse_error: tool.malformedCalls,
    },
    overall: textPass && toolPass ? 'passed' : 'needs_adaptation',
  });
}

async function probe(provider, request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const assembler = new ToolCallAssembler();
  let text = '';
  let terminal = false;
  try {
    for await (const item of provider.stream(Object.freeze(request), controller.signal)) {
      if (item.type === 'text') text += item.text;
      else if (item.type === 'tool_fragment') assembler.add(item.fragments);
      else if (item.type === 'terminal') terminal = true;
      if (Buffer.byteLength(text, 'utf8') > MAX_QUALIFICATION_OUTPUT_BYTES) throw new ContractError('qualification_output_too_large', 'qualification output exceeded its bound');
    }
  } catch (error) {
    if (controller.signal.aborted) throw new ContractError('qualification_timeout', 'model qualification timed out', true);
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
  let calls = [];
  let malformedCalls = false;
  try { calls = assembler.complete(); } catch { malformedCalls = true; }
  return { text, terminal, calls, malformedCalls };
}
