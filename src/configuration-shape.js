// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { CONFIGURATION_KEYS as KEYS } from './configuration-keys.js';

const SECURITY_KEY = /review|permission|ledger|revalid|auto.?approv|security|sandbox|secret|credential|token|auth|redact|sensitive|encrypt/iu;

export function validateNestedManifestKeys(manifest) {
  if (!record(manifest)) {
    throw new ContractError('manifest_shape_invalid', 'configuration manifest must be an object');
  }
  const warnings = [];
  inspectObject(manifest.provider, 'provider', KEYS.provider, warnings);
  inspectArray(manifest.providers, 'providers', KEYS.provider, warnings, inspectProviderCapabilities);
  inspectProviderCapabilities(manifest.provider, 'provider', warnings);
  inspectRoutes(manifest.routes, warnings);
  inspectObject(manifest.attachments, 'attachments', KEYS.attachments, warnings);
  inspectObject(manifest.memory, 'memory', KEYS.memory, warnings);
  inspectObject(manifest.dream, 'dream', KEYS.dream, warnings);
  inspectObject(manifest.tui, 'tui', KEYS.tui, warnings);
  inspectObject(manifest.telemetry, 'telemetry', KEYS.telemetry, warnings);
  inspectObject(manifest.reviewer_ledger, 'reviewer_ledger', KEYS.reviewerLedger, warnings);
  inspectObject(manifest.recovery, 'recovery', KEYS.recovery, warnings);
  inspectArray(manifest.mcp_servers, 'mcp_servers', KEYS.mcp, warnings, inspectMcpChildren);
  inspectArray(manifest.skills, 'skills', KEYS.skill, warnings);
  inspectMission(manifest.mission, warnings);
  return warnings;
}

function inspectProviderCapabilities(value, path, warnings) {
  if (record(value)) {
    inspectObject(value.capabilities, `${path}.capabilities`, KEYS.capabilities, warnings);
    inspectObject(value.credential, `${path}.credential`, KEYS.credential, warnings);
  }
}

function inspectRoutes(value, warnings) {
  if (!record(value)) return;
  inspectObject(value, 'routes', KEYS.roles, warnings);
  for (const role of KEYS.roles) {
    inspectObject(value[role], `routes.${role}`, KEYS.route, warnings);
  }
}

function inspectMcpChildren(value, path, warnings) {
  if (!record(value)) return;
  inspectObject(value.credential, `${path}.credential`, KEYS.credential, warnings);
  if (record(value.header_credentials)) {
    for (const [header, binding] of Object.entries(value.header_credentials)) {
      inspectObject(binding, `${path}.header_credentials.${header}`, KEYS.credential, warnings);
    }
  }
  inspectDynamic(value.header_env, `${path}.header_env`, warnings);
  inspectDynamic(value.tool_effects, `${path}.tool_effects`, warnings);
}

function inspectMission(value, warnings) {
  inspectObject(value, 'mission', KEYS.mission, warnings);
  if (!record(value)) return;
  inspectObject(value.bounds, 'mission.bounds', KEYS.missionBounds, warnings);
  inspectObject(value.termination, 'mission.termination', KEYS.missionTermination, warnings);
}

function inspectArray(value, path, allowed, warnings, children) {
  if (value === undefined) return;
  if (!Array.isArray(value)) { warnings.push(`unknown manifest shape ignored: ${path}`); return; }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!record(item)) { warnings.push(`unknown manifest shape ignored: ${itemPath}`); return; }
    inspectObject(item, itemPath, allowed, warnings);
    children?.(item, itemPath, warnings);
  });
}

function inspectObject(value, path, allowed, warnings) {
  if (value === undefined) return;
  if (!record(value)) { warnings.push(`unknown manifest shape ignored: ${path}`); return; }
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) unknown(`${path}.${key}`, key, warnings);
  }
}

function inspectDynamic(value, path, warnings) {
  if (value === undefined || record(value)) return;
  warnings.push(`unknown manifest shape ignored: ${path}`);
}

function unknown(path, key, warnings) {
  if (SECURITY_KEY.test(key)) {
    const error = new ContractError('unknown_security_key', `unknown security-relevant manifest key ${path}`);
    error.configurationKey = path;
    throw error;
  }
  warnings.push(`unknown manifest key ignored: ${path}`);
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
