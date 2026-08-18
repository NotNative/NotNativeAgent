// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';

const MANIFEST_VERSION = '1.0';
const MAX_CONTEXT_SOURCES = 512;

export function providerRequestManifest(request, context, route, active) {
  const messages = request?.messages;
  const tools = request?.tools ?? [];
  if (!request || typeof request !== 'object' || !Array.isArray(messages) || !Array.isArray(tools)) {
    throw new ContractError('provider_request_invalid', 'provider request manifest requires messages and tools');
  }
  const configuration = requestConfiguration(request);
  const sources = (Array.isArray(context) ? context : []).slice(-MAX_CONTEXT_SOURCES).map((item, index) => Object.freeze({
    index,
    provenance: boundedLabel(item?.provenance, 'unattributed'),
    trust: boundedLabel(item?.trust, 'unclassified'),
    fingerprint: digest(providerMessage(item)),
  }));
  return Object.freeze({
    version: MANIFEST_VERSION, type: 'provider_request_manifest',
    turnId: active?.turnId ?? null, stepId: active?.stepId ?? null,
    logicalRequestId: active?.logicalRequestId ?? route?.logicalRequestId ?? null,
    providerProfile: route?.profile?.id ?? null, model: request.model,
    requestFingerprint: digest(request), messagesFingerprint: digest(messages),
    toolsFingerprint: digest(tools), configFingerprint: digest(configuration),
    sourceFingerprint: digest(sources),
    messageCount: messages.length, toolCount: tools.length,
    sources: Object.freeze(sources),
  });
}

export function assertProviderRequestManifest(request, manifest, route, active) {
  if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.type !== 'provider_request_manifest') {
    throw desync('provider request has no valid durable manifest');
  }
  const mismatches = [];
  if (manifest.turnId !== (active?.turnId ?? null)) mismatches.push('turn');
  if (manifest.stepId !== (active?.stepId ?? null)) mismatches.push('step');
  if (manifest.logicalRequestId !== (active?.logicalRequestId ?? route?.logicalRequestId ?? null)) mismatches.push('logical_request');
  if (manifest.providerProfile !== (route?.profile?.id ?? active?.providerResource ?? null)) mismatches.push('provider');
  if (manifest.model !== request?.model) mismatches.push('model');
  if (manifest.requestFingerprint !== digest(request)) mismatches.push('request');
  if (manifest.messagesFingerprint !== digest(request?.messages)) mismatches.push('messages');
  if (manifest.toolsFingerprint !== digest(request?.tools ?? [])) mismatches.push('tools');
  if (manifest.configFingerprint !== digest(requestConfiguration(request))) mismatches.push('config');
  if (manifest.messageCount !== request?.messages?.length) mismatches.push('message_count');
  if (manifest.toolCount !== (request?.tools?.length ?? 0)) mismatches.push('tool_count');
  if (mismatches.length > 0) throw desync(`provider request diverged from its durable manifest: ${mismatches.join(', ')}`);
  return true;
}

function requestConfiguration(request) {
  if (!request || typeof request !== 'object') return null;
  const { messages: _messages, tools: _tools, ...configuration } = request;
  return configuration;
}

function providerMessage(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const { provenance: _provenance, trust: _trust, ...message } = item;
  return message;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(normalize(value, seen));
}

function normalize(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ContractError('provider_request_invalid', 'provider request contains a non-finite number');
    return value;
  }
  if (value === undefined) return null;
  if (typeof value !== 'object') throw new ContractError('provider_request_invalid', 'provider request contains a non-JSON value');
  if (seen.has(value)) throw new ContractError('provider_request_invalid', 'provider request contains a cycle');
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) normalized = value.map((item) => normalize(item, seen));
  else {
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) normalized[key] = normalize(value[key], seen);
    }
  }
  seen.delete(value);
  return normalized;
}

function boundedLabel(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : fallback;
}

function desync(message) {
  return new ContractError('provider_request_reconstruction_desync', message);
}

