// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveManifest } from '../src/config.js';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { ToolCallAssembler } from '../src/tool-calls.js';
import { VERSION } from '../src/product.js';

const TOOL = Object.freeze({
  type: 'function', function: {
    name: 'nna_conformance_echo', description: 'Return the supplied text.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string' } },
    },
  },
});

export async function runProviderConformance(document, options = {}) {
  const input = validateDocument(document);
  const measuredAt = (options.now ?? (() => new Date()))().toISOString();
  const providers = [];
  for (const candidate of input.providers) providers.push(await probeProvider(candidate, options));
  return Object.freeze({
    schema_version: 1, product_version: VERSION, measured_at: measuredAt,
    evidence_kind: 'live_provider_neutrality', content_retained: false,
    independent_implementation_claim: 'operator_declared',
    passed: providers.every((item) => item.passed), providers,
  });
}

async function probeProvider(candidate, options) {
  const config = resolveManifest({ persistence: 'ephemeral', provider: {
    id: candidate.id, endpoint: candidate.endpoint, model: candidate.model,
    trust_zone: candidate.trust_zone, credential_env: candidate.credential_env,
    capabilities: { streaming: true, tools: true },
  } });
  const profile = config.providerProfiles[candidate.id];
  const adapter = new OpenAICompatibleProvider(profile, {
    connectMs: candidate.timeout_ms, maxOutputBytes: 2_097_152,
  }, { fetch: options.fetch ?? globalThis.fetch });
  const cases = [];
  cases.push(await measuredCase('model_enumeration', candidate.timeout_ms, async (signal) => {
    const capabilities = await adapter.capabilities(signal);
    if (!capabilities.models.includes(candidate.model)) throw coded('selected_model_missing');
    return { model_count: capabilities.models.length };
  }));
  cases.push(await measuredCase('streaming_text', candidate.timeout_ms, async (signal) => {
    const result = await consume(adapter, request(candidate.model, false), signal);
    if (result.text_bytes === 0) throw coded('provider_empty_text');
    return result;
  }));
  cases.push(await measuredCase('streaming_tool_call', candidate.timeout_ms, async (signal) => {
    const result = await consume(adapter, request(candidate.model, true), signal);
    if (!result.valid_tool_call) throw coded('provider_tool_call_missing');
    return result;
  }));
  return Object.freeze({
    id: candidate.id, implementation: candidate.implementation,
    implementation_version: candidate.implementation_version,
    endpoint_origin: new URL(profile.endpoint).origin, model: candidate.model,
    passed: cases.every((item) => item.passed), cases,
  });
}

function request(model, tools) {
  return Object.freeze({
    model, temperature: 0, maxOutputTokens: 256,
    messages: tools ? [
      { role: 'system', content: 'Call nna_conformance_echo exactly once with text set to provider-ok. Do not answer in prose.' },
      { role: 'user', content: 'Run the conformance tool now.' },
    ] : [
      { role: 'system', content: 'Reply with a brief plain-text acknowledgement.' },
      { role: 'user', content: 'Provider conformance check.' },
    ],
    tools: tools ? [TOOL] : [],
  });
}

async function consume(adapter, providerRequest, signal) {
  const assembler = new ToolCallAssembler();
  let textBytes = 0; let reasoningBytes = 0; let usageEvents = 0; let terminalEvents = 0;
  for await (const item of adapter.stream(providerRequest, signal)) {
    if (terminalEvents > 0) throw coded('provider_conflicting_terminal');
    if (item.type === 'text') textBytes += Buffer.byteLength(item.text, 'utf8');
    else if (item.type === 'reasoning') reasoningBytes += Buffer.byteLength(item.text, 'utf8');
    else if (item.type === 'tool_fragment') assembler.add(item.fragments);
    else if (item.type === 'usage') usageEvents += 1;
    else if (item.type === 'terminal') terminalEvents += 1;
  }
  if (terminalEvents !== 1) throw coded('provider_terminal_count_invalid');
  const calls = assembler.complete();
  const valid = calls.some((call) => !call.invalid && call.name === 'nna_conformance_echo'
    && typeof call.args?.text === 'string');
  return {
    text_bytes: textBytes, reasoning_bytes: reasoningBytes, usage_events: usageEvents,
    terminal_events: terminalEvents, tool_call_count: calls.length, valid_tool_call: valid,
  };
}

async function measuredCase(name, timeoutMs, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const metrics = await operation(controller.signal);
    return Object.freeze({ name, passed: true, elapsed_ms: round(performance.now() - started), ...metrics });
  } catch (error) {
    return Object.freeze({
      name, passed: false, elapsed_ms: round(performance.now() - started),
      error_code: safeCode(controller.signal.aborted ? 'provider_conformance_timeout' : error?.code),
    });
  } finally { clearTimeout(timer); controller.abort(); }
}

function validateDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1
    || !Array.isArray(value.providers) || value.providers.length < 2 || value.providers.length > 8) {
    throw coded('provider_conformance_config_invalid');
  }
  const ids = new Set(); const implementations = new Set();
  const providers = value.providers.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(item.id ?? '')
      || !boundedText(item.implementation, 128) || !boundedText(item.implementation_version, 128)
      || !boundedText(item.endpoint, 2048) || !boundedText(item.model, 256)
      || !['loopback', 'private_network', 'public_network'].includes(item.trust_zone)
      || (item.credential_env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(item.credential_env))) {
      throw coded('provider_conformance_config_invalid');
    }
    if (ids.has(item.id) || implementations.has(item.implementation)) {
      throw coded('provider_conformance_independence_invalid');
    }
    ids.add(item.id); implementations.add(item.implementation);
    return { ...item, timeout_ms: boundedTimeout(item.timeout_ms) };
  });
  return Object.freeze({ providers });
}

function boundedTimeout(value) {
  if (value === undefined) return 60_000;
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) throw coded('provider_conformance_config_invalid');
  return value;
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,128}$/u.test(value) ? value : 'provider_conformance_failed';
}

function round(value) { return Math.round(value * 1000) / 1000; }

async function main() {
  const configPath = argument('--config'); const outputPath = argument('--output');
  if (!configPath) throw coded('provider_conformance_config_required');
  const document = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  const report = await runProviderConformance(document);
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(resolve(outputPath), encoded, { encoding: 'utf8', mode: 0o600 });
  else process.stdout.write(encoded);
  if (!report.passed) process.exitCode = 1;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${safeCode(error?.code)}\n`); process.exitCode = 1;
  });
}
