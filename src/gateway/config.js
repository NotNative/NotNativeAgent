// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ContractError } from '../ids.js';

const MAX_CONFIG_BYTES = 65_536;
const DEFAULT_POLLING_TIMEOUT_SECONDS = 25;
const MIN_POLLING_TIMEOUT_SECONDS = 5;
const MAX_POLLING_TIMEOUT_SECONDS = 50;

export const DEFAULT_GATEWAY_CONFIG = Object.freeze({
  version: 1, enabled: false, token: null, token_env: 'NNA_TELEGRAM_BOT_TOKEN',
  authorized_user_ids: Object.freeze([]), workspace_root: null,
  polling_timeout_seconds: DEFAULT_POLLING_TIMEOUT_SECONDS,
});

export async function loadGatewayConfig(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_CONFIG_BYTES) throw new ContractError('gateway_config_too_large', 'gateway configuration exceeds its size bound');
    return normalizeGatewayConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_GATEWAY_CONFIG;
    if (error instanceof ContractError) throw error;
    const failure = new ContractError('gateway_config_invalid', 'gateway configuration is not valid UTF-8 JSON');
    failure.cause = error;
    throw failure;
  }
}

export async function saveGatewayConfig(path, value) {
  const config = normalizeGatewayConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return config;
}

export function normalizeGatewayConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('gateway_config_invalid', 'gateway configuration must be an object');
  }
  const ids = [...new Set((value.authorized_user_ids ?? []).map(normalizeUserId))].sort();
  const workspace = value.workspace_root == null ? null : resolveWorkspace(value.workspace_root);
  const timeout = value.polling_timeout_seconds ?? DEFAULT_POLLING_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < MIN_POLLING_TIMEOUT_SECONDS || timeout > MAX_POLLING_TIMEOUT_SECONDS) {
    throw new ContractError('gateway_polling_timeout_invalid', 'polling timeout must be an integer from 5 through 50 seconds');
  }
  const updatedAt = normalizeUpdatedAt(value.updated_at);
  return Object.freeze({
    version: 1,
    enabled: value.enabled === true,
    token: normalizeOptionalSecret(value.token),
    token_env: normalizeEnvironmentName(value.token_env ?? 'NNA_TELEGRAM_BOT_TOKEN'),
    authorized_user_ids: Object.freeze(ids),
    workspace_root: workspace,
    polling_timeout_seconds: timeout,
    ...(updatedAt === null ? {} : { updated_at: updatedAt }),
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
  if (typeof value !== 'string' && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new ContractError('telegram_user_id_invalid', 'Telegram user ID must be a positive numeric string or safe integer');
  }
  const text = String(value).trim();
  if (!/^[1-9][0-9]{0,19}$/u.test(text)) throw new ContractError('telegram_user_id_invalid', 'Telegram user ID must be a positive numeric ID');
  return text;
}

function normalizeUpdatedAt(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractError('gateway_config_invalid', 'gateway configuration updated_at must be an ISO timestamp');
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new ContractError('gateway_config_invalid', 'gateway configuration updated_at must be an ISO timestamp');
  }
  return value;
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
