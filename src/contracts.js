// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { failureEnvelope } from './failure-envelope.js';

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
/** Terminal turn outcomes exposed to protocol consumers and configuration validation. */
export const TURN_OUTCOMES = Object.freeze([
  'completed', 'blocked', 'incomplete', 'needs_input', 'denied', 'cancelled', 'failed', 'limit_reached',
]);
/** Execution roles accepted by manifests and route configuration. */
export const ROLES = Object.freeze(['primary', 'reviewer', 'subagent', 'vision']);

const PROTOCOL_LIMITS = Object.freeze({
  lineBytes: 262_144, contentBytes: 131_072, depth: 24, nodes: 20_000,
  stringChars: 131_072, collectionItems: 4_096, attachments: 16,
  attachmentPathChars: 4_096, mimeTypeChars: 128,
});
const PERMISSION_CHOICES = Object.freeze(['allow_once', 'allow_session', 'allow_workspace', 'deny', 'cancel']);

const INPUT_TYPES = new Set([
  'initialize', 'submit', 'steer', 'cancel', 'configuration_update', 'shutdown',
  'attachment_retry', 'attachment_remove',
]);

export function parseProtocolLine(line, limits = {}) {
  const maxBytes = boundedProtocolLimit(limits.maxLineBytes, PROTOCOL_LIMITS.lineBytes);
  if (Buffer.byteLength(line, 'utf8') > maxBytes) {
    throw new ContractError('line_too_large', `input exceeds ${maxBytes} bytes`);
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ContractError('malformed_json', 'input is not valid JSON');
  }
  // Parsed input is bounded and schema-checked below.
  validateTree(value, limits);
  return validateCommand(value);
}

export function validateCommand(value, options = {}) {
  if (!isRecord(value)) throw new ContractError('invalid_command', 'command must be an object');
  requireExternalId(value.request_id);
  const permissionDecision = value.type === 'permission_decision' && options.interactive === true;
  if (!INPUT_TYPES.has(value.type) && !permissionDecision) {
    throw new ContractError('unknown_control', 'unknown or unsupported control message');
  }
  const version = parseVersion(value.version);
  if (version.major !== PROTOCOL_VERSION.major) {
    throw new ContractError('incompatible_version', 'protocol major version is incompatible');
  }
  if (value.type === 'submit' || value.type === 'steer') validateContent(value.content);
  if (value.type === 'attachment_retry') {
    validateContent(value.content);
    validateAttachmentId(value.attachment_id);
  }
  if (value.type === 'attachment_remove') validateAttachmentId(value.attachment_id);
  if (permissionDecision) validatePermissionDecision(value);
  if (value.type === 'configuration_update' && !isRecord(value.manifest)) {
    throw new ContractError('configuration_update_invalid', 'configuration update requires a complete manifest');
  }
  if (value.type === 'initialize') validateInitialization(value);
  if (value.type === 'submit') validateAttachments(value.attachments);
  return Object.freeze({ ...value, version: `${version.major}.${version.minor}` });
}

function validateInitialization(value) {
  if (!isRecord(value.manifest)) throw new ContractError('initialization_manifest_invalid', 'initialize requires an execution manifest');
  validateProviderProfileId(value.manifest.provider_profile_id, 'manifest.provider_profile_id');
  validateProviderProfileId(value.provider_profile_id, 'provider_profile_id');
  if (value.manifest.provider_profile_id !== undefined && value.provider_profile_id !== undefined
    && value.manifest.provider_profile_id !== value.provider_profile_id) {
    throw new ContractError('provider_profile_mismatch', 'provider_profile_id must match manifest.provider_profile_id');
  }
  if (value.provider_profile !== undefined && (typeof value.provider_profile !== 'string'
    || value.provider_profile.length === 0 || value.provider_profile.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value.provider_profile))) {
    throw new ContractError('provider_profile_invalid', 'provider_profile must be bounded printable text');
  }
  if (value.execution_manifest_id !== undefined) requireExternalId(value.execution_manifest_id, 'execution_manifest_id');
  if (value.host_origin !== undefined && (typeof value.host_origin !== 'string' || value.host_origin.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value.host_origin))) {
    throw new ContractError('host_origin_invalid', 'host_origin must be bounded printable text');
  }
  if (value.host_identity !== undefined && (!isRecord(value.host_identity)
    || Object.keys(value.host_identity).length > 7)) {
    throw new ContractError('host_identity_invalid', 'host_identity must be a bounded object');
  }
}

function validateProviderProfileId(value, field) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new ContractError('provider_profile_invalid', `${field} must be a stable provider profile id`);
  }
}

function validatePermissionDecision(value) {
  for (const field of ['permission_token', 'tool_request_id']) requireExternalId(value[field]);
  if (!PERMISSION_CHOICES.includes(value.choice)) {
    throw new ContractError('invalid_permission_choice', 'permission choice is invalid');
  }
}

function validateAttachmentId(value) {
  if (typeof value !== 'string' || !/^attachment_[A-Za-z0-9-]+$/u.test(value)) {
    throw new ContractError('invalid_attachment_id', 'attachment_id is invalid');
  }
}

function validateAttachments(value) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > PROTOCOL_LIMITS.attachments) {
    throw new ContractError('invalid_attachments', 'attachments must be an array of at most sixteen items');
  }
  for (const item of value) {
    if (!isRecord(item) || typeof item.path !== 'string' || item.path.length > PROTOCOL_LIMITS.attachmentPathChars
      || typeof item.mime_type !== 'string' || item.mime_type.length > PROTOCOL_LIMITS.mimeTypeChars) {
      throw new ContractError('invalid_attachment', 'attachment descriptors require bounded path and mime_type');
    }
  }
}

export function safeError(error, operation) {
  const envelope = failureEnvelope(error, { operation, boundary: operation });
  return { ...envelope, operation, next_action: nextAction(envelope.code, envelope.retryable) };
}

function nextAction(code, retryable) {
  const parts = new Set(String(code).split('_'));
  if (parts.has('credential') || parts.has('credentials')) return 'Configure the referenced credential and retry.';
  if (parts.has('permission') || parts.has('permissions')) return 'Review the request in an authenticated interactive session.';
  if (parts.has('config') || parts.has('configuration') || parts.has('manifest')) return 'Correct the configuration and initialize again.';
  if (retryable) return 'Retry after checking the affected dependency.';
  return 'Inspect local health and diagnostics using the stable error code.';
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+$/u.test(value)) {
    throw new ContractError('invalid_version', 'version must be major.minor');
  }
  const [major, minor] = value.split('.').map(Number);
  return { major, minor };
}

function validateContent(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractError('invalid_content', 'submit content must be non-empty text');
  }
  if (Buffer.byteLength(value, 'utf8') > PROTOCOL_LIMITS.contentBytes) {
    throw new ContractError('content_too_large', 'submit content exceeds 131072 bytes');
  }
}

function validateTree(root, limits = {}) {
  const maxDepth = boundedProtocolLimit(limits.maxDepth, PROTOCOL_LIMITS.depth);
  const maxNodes = boundedProtocolLimit(limits.maxNodes, PROTOCOL_LIMITS.nodes);
  const stack = [{ value: root, depth: 0 }];
  const visited = new WeakSet();
  let count = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item.value && typeof item.value === 'object') {
      if (visited.has(item.value)) continue;
      visited.add(item.value);
    }
    count += 1;
    if (count > maxNodes || item.depth > maxDepth) {
      throw new ContractError('structure_too_large', 'input structure exceeds bounds');
    }
    if (typeof item.value === 'string' && item.value.length > PROTOCOL_LIMITS.stringChars) {
      throw new ContractError('string_too_large', 'input string exceeds bound');
    }
    if (Array.isArray(item.value)) pushChildren(stack, item.value, item.depth);
    else if (isRecord(item.value)) pushChildren(stack, Object.values(item.value), item.depth);
  }
}

function boundedProtocolLimit(value, ceiling) {
  if (!Number.isSafeInteger(value) || value < 1) return ceiling;
  return Math.min(value, ceiling);
}

function pushChildren(stack, values, depth) {
  if (values.length > PROTOCOL_LIMITS.collectionItems) throw new ContractError('collection_too_large', 'collection exceeds bound');
  for (const value of values) stack.push({ value, depth: depth + 1 });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
