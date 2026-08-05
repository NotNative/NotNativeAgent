// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { failureEnvelope } from './failure-envelope.js';

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
export const TURN_OUTCOMES = Object.freeze([
  'completed', 'incomplete', 'needs_input', 'denied', 'cancelled', 'failed', 'limit_reached',
]);
export const ROLES = Object.freeze(['primary', 'reviewer', 'subagent', 'vision']);

const INPUT_TYPES = new Set([
  'initialize', 'submit', 'steer', 'cancel', 'configuration_update', 'shutdown',
  'attachment_retry', 'attachment_remove',
]);

export function parseProtocolLine(line, limits = {}) {
  const maxBytes = limits.maxLineBytes ?? 262_144;
  if (Buffer.byteLength(line, 'utf8') > maxBytes) {
    throw new ContractError('line_too_large', `input exceeds ${maxBytes} bytes`);
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ContractError('malformed_json', 'input is not valid JSON');
  }
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

function validatePermissionDecision(value) {
  for (const field of ['permission_token', 'tool_request_id']) requireExternalId(value[field]);
  if (!['allow_once', 'allow_session', 'allow_workspace', 'deny', 'cancel'].includes(value.choice)) {
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
  if (!Array.isArray(value) || value.length > 16) {
    throw new ContractError('invalid_attachments', 'attachments must be an array of at most sixteen items');
  }
  for (const item of value) {
    if (!isRecord(item) || typeof item.path !== 'string' || item.path.length > 4096
      || typeof item.mime_type !== 'string' || item.mime_type.length > 128) {
      throw new ContractError('invalid_attachment', 'attachment descriptors require bounded path and mime_type');
    }
  }
}

export function safeError(error, operation) {
  const envelope = failureEnvelope(error, { operation, boundary: operation });
  return { ...envelope, operation, next_action: nextAction(envelope.code, envelope.retryable) };
}

function nextAction(code, retryable) {
  if (code.includes('credential')) return 'Configure the referenced credential and retry.';
  if (code.includes('permission')) return 'Review the request in an authenticated interactive session.';
  if (code.includes('config') || code.includes('manifest')) return 'Correct the configuration and initialize again.';
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
  if (Buffer.byteLength(value, 'utf8') > 131_072) {
    throw new ContractError('content_too_large', 'submit content exceeds 131072 bytes');
  }
}

function validateTree(root, limits = {}) {
  const maxDepth = limits.maxDepth ?? 24;
  const maxNodes = limits.maxNodes ?? 20_000;
  const stack = [{ value: root, depth: 0 }];
  let count = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    count += 1;
    if (count > maxNodes || item.depth > maxDepth) {
      throw new ContractError('structure_too_large', 'input structure exceeds bounds');
    }
    if (typeof item.value === 'string' && item.value.length > 131_072) {
      throw new ContractError('string_too_large', 'input string exceeds bound');
    }
    if (Array.isArray(item.value)) pushChildren(stack, item.value, item.depth);
    else if (isRecord(item.value)) pushChildren(stack, Object.values(item.value), item.depth);
  }
}

function pushChildren(stack, values, depth) {
  if (values.length > 4096) throw new ContractError('collection_too_large', 'collection exceeds bound');
  for (const value of values) stack.push({ value, depth: depth + 1 });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
