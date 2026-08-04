// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ContractError } from './ids.js';

export const DEFAULT_GATEWAY_CONFIG = Object.freeze({
  version: 1, enabled: false, token: null, token_env: 'NNA_TELEGRAM_BOT_TOKEN',
  authorized_user_ids: Object.freeze([]), workspace_root: null, polling_timeout_seconds: 25,
});

export async function loadGatewayConfig(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 65_536) throw new ContractError('gateway_config_too_large', 'gateway configuration exceeds its size bound');
    return normalizeGatewayConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_GATEWAY_CONFIG;
    if (error instanceof ContractError) throw error;
    throw new ContractError('gateway_config_invalid', 'gateway configuration is not valid UTF-8 JSON');
  }
}

export async function saveGatewayConfig(path, value) {
  const config = normalizeGatewayConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return config;
}

export function normalizeGatewayConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('gateway_config_invalid', 'gateway configuration must be an object');
  }
  const ids = [...new Set((value.authorized_user_ids ?? []).map(normalizeUserId))].sort();
  const workspace = value.workspace_root == null ? null : resolveWorkspace(value.workspace_root);
  const timeout = value.polling_timeout_seconds ?? 25;
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 50) {
    throw new ContractError('gateway_polling_timeout_invalid', 'polling timeout must be an integer from 5 through 50 seconds');
  }
  return Object.freeze({
    version: 1,
    enabled: value.enabled === true,
    token: normalizeOptionalSecret(value.token),
    token_env: normalizeEnvironmentName(value.token_env ?? 'NNA_TELEGRAM_BOT_TOKEN'),
    authorized_user_ids: Object.freeze(ids),
    workspace_root: workspace,
    polling_timeout_seconds: timeout,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : undefined,
  });
}

export function gatewayToken(config, environment = process.env) {
  const fromEnvironment = environment[config.token_env]?.trim();
  if (fromEnvironment) return { value: fromEnvironment, source: config.token_env };
  if (config.token) return { value: config.token, source: 'restricted local config' };
  return { value: null, source: null };
}

export function gatewayPublicStatus(config, environment = process.env) {
  const token = gatewayToken(config, environment);
  return Object.freeze({
    enabled: config.enabled, configured: Boolean(token.value), token_source: token.source,
    authorized_user_ids: [...config.authorized_user_ids], workspace_root: config.workspace_root,
    polling_timeout_seconds: config.polling_timeout_seconds,
  });
}

export function normalizeUserId(value) {
  const text = String(value).trim();
  if (!/^[1-9][0-9]{0,19}$/u.test(text)) throw new ContractError('telegram_user_id_invalid', 'Telegram user ID must be a positive numeric ID');
  return text;
}

function normalizeOptionalSecret(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length < 20 || value.length > 512 || /[\r\n]/u.test(value)) {
    throw new ContractError('telegram_token_invalid', 'Telegram bot token is invalid');
  }
  return value;
}

function normalizeEnvironmentName(value) {
  if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(value)) {
    throw new ContractError('gateway_token_env_invalid', 'gateway token environment name is invalid');
  }
  return value;
}

function resolveWorkspace(value) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new ContractError('gateway_workspace_invalid', 'gateway workspace must be an absolute path');
  }
  return resolve(value);
}
