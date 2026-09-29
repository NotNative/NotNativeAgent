// SPDX-License-Identifier: Apache-2.0
/** Bounded MCP config-file storage for the harness `mcp` map (doc 15 F.1). */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join as joinPath } from 'node:path';
import { directAbsolute } from '../skills/skill-scan.ts';
import { withConfigLock } from '../../scheduled/config-lock.ts';

export type McpScope = 'user' | 'project';
export type McpRecord = {
  type: 'local' | 'remote';
  command?: string[];
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: Record<string, string> | false;
  timeout?: number;
  enabled: boolean;
};
export type McpResponseRecord = McpRecord & { name: string; scope: McpScope };

const MAX_NAME = 128;
const MAX_URL = 2_048;
const MAX_COMMAND_ARGS = 64;
const MAX_ARGUMENT_BYTES = 1_024;
const MAX_MAP_KEYS = 64;
const MAX_MAP_VALUE_BYTES = 4_096;
const MAX_OAUTH_FIELD_BYTES = 4_096;
const NAME = new RegExp(`^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$`, 'u');
const OAUTH_FIELDS = ['clientId', 'clientSecret', 'scope', 'redirectUri'] as const;

export function mcpNameOk(name: string): boolean {
  return NAME.test(name);
}

export class McpConfigError extends Error {
  readonly status: 400 | 404 | 500;
  constructor(message: string, status: 400 | 404 | 500 = 400) {
    super(message);
    this.status = status;
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== null && code !== undefined && (code < 0x20 || code === 0x7f);
  });
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value === '' || hasControlCharacters(value) || value.length > maximum) {
    throw new McpConfigError(`${label} is invalid`);
  }
  return value;
}

function textMap(value: unknown, label: string, maximum = MAX_MAP_VALUE_BYTES): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpConfigError(`${label} must be a record of strings`);
  }
  const source = Object.entries(value as Record<string, unknown>);
  if (source.length > MAX_MAP_KEYS) throw new McpConfigError(`${label} has too many entries`);
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of source) {
    const key = rawKey.trim();
    if (key === '' || key !== rawKey || key.length > 128 || hasControlCharacters(key)) {
      throw new McpConfigError(`${label} contains an invalid key`);
    }
    if (!safeKey(key) || typeof rawValue !== 'string' || rawValue.length > maximum || hasControlCharacters(rawValue)) {
      throw new McpConfigError(`${label} contains an invalid value`);
    }
    if (rawValue !== '') result[key] = rawValue;
  }
  return result;
}

function safeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

function isBoundedArgument(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && value.length <= MAX_ARGUMENT_BYTES
    && !hasControlCharacters(value);
}

function userConfigFile(): string {
  const configuredRoot = directAbsolute(process.env.OPENCODE_CONFIG_DIR);
  return joinPath(configuredRoot ?? joinPath(homedir(), '.opencode'), 'opencode.json');
}

export function projectConfigFile(directory: string | undefined): string | null {
  if (typeof directory !== 'string' || directory === '' || directory.length > 1_024) return null;
  const normalized = directory.replaceAll('\\', '/').replace(/\/+$/u, '');
  if (normalized === '' || hasControlCharacters(normalized) || !isAbsolute(normalized) || normalized.includes('\0')) {
    return null;
  }
  try {
    const checkout = realpathSync(normalized);
    if (!isAbsolute(checkout) || checkout.length > 1_024 || hasControlCharacters(checkout)) return null;
    if (!statSync(checkout, { throwIfNoEntry: false })?.isDirectory()) return null;
    return joinPath(checkout, '.opencode', 'opencode.json');
  } catch {
    return null;
  }
}

function scopeConfigFile(scope: McpScope, directory: string | undefined): string {
  if (scope === 'user') return userConfigFile();
  const project = projectConfigFile(directory);
  if (project === null) throw new McpConfigError('project checkout directory is required');
  return project;
}

type MutableMcp = Record<string, unknown>;
type ConfigObject = Record<string, unknown>;
type LayerRecord = { name: string; scope: McpScope; path: string; record: McpRecord };

function readConfig(path: string, required: boolean): ConfigObject {
  if (!existsSync(path)) {
    if (required) throw new McpConfigError('MCP configuration file is not readable', 500);
    return {};
  }
  const stats = readFileSync(path, { flag: 'r' });
  if (stats.byteLength > 1_048_576) throw new McpConfigError('MCP configuration file is oversized', 500);
  let parsed: unknown;
  try { parsed = JSON.parse(stats.toString('utf8')); } catch {
    throw new McpConfigError('MCP configuration file is malformed', 500);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McpConfigError('MCP configuration file must contain a JSON object', 500);
  }
  const config = parsed as ConfigObject;
  const map = config.mcp;
  if (map === undefined) return config;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new McpConfigError('MCP configuration map is malformed', 500);
  }
  return config;
}

function mcpMap(config: ConfigObject): MutableMcp {
  const map = config.mcp;
  return typeof map === 'object' && map !== null && !Array.isArray(map) ? map as MutableMcp : {};
}

function storedLayer(scope: McpScope, path: string): LayerRecord[] {
  const map = mcpMap(readConfig(path, false));
  const result: LayerRecord[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!mcpNameOk(name)) continue;
    const sanitized = sanitizeMcpEntry(raw);
    if (sanitized.error) continue;
    result.push({ name, scope, path, record: sanitized.value });
  }
  return result;
}

export async function readMcpLayers(directory: string | undefined): Promise<LayerRecord[]> {
  const layers = storedLayer('user', userConfigFile());
  if (projectConfigFile(directory) === null) return layers;
  const path = scopeConfigFile('project', directory);
  return [...layers, ...storedLayer('project', path)];
}

export async function listMcpConfig(directory: string | undefined): Promise<Record<string, McpResponseRecord>> {
  const merged: Record<string, McpResponseRecord> = {};
  for (const layer of await readMcpLayers(directory)) {
    const visible = { ...layer.record, oauth: layer.record.oauth === undefined ? undefined : layer.record.oauth };
    if (visible.oauth === undefined) delete visible.oauth;
    merged[layer.name] = { ...visible, name: layer.name, scope: layer.scope };
  }
  return merged;
}

function bodyData(raw: Record<string, unknown>): Result<Record<string, unknown>> {
  try {
    const scope = raw.scope ?? 'user';
    if ((raw.scope !== undefined && raw.scope !== 'user' && raw.scope !== 'project')
      || (scope !== 'user' && scope !== 'project')) {
      return failure('scope must be user or project');
    }
    const data = { ...raw };
    delete data.scope;
    delete data.directory;
    delete data.name;
    return success(data);
  } catch (error) {
    return { error: error instanceof Error ? error : new McpConfigError('invalid MCP request') };
  }
}

function tooManyServers(map: MutableMcp): boolean {
  return Object.keys(map).length >= 128;
}

async function writeConfigAtomic(path: string, value: ConfigObject): Promise<void> {
  const { mkdir, rename, writeFile } = await import('node:fs/promises');
  await mkdir(joinPath(path, '..'), { recursive: true });
  const temporary = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  await rename(temporary, path);
}

function findLayer(layers: LayerRecord[], name: string): LayerRecord | undefined {
  return [...layers].reverse().find((layer) => layer.name === name);
}

function storedAt(path: string, name: string): McpRecord | undefined {
  const sanitized = storedLayer('project', path).find((layer) => layer.name === name);
  return sanitized?.record;
}

function mapWith(config: ConfigObject, name: string, record: McpRecord): ConfigObject {
  const map = mcpMap(config);
  const persisted = { ...record };
  if (persisted.oauth === undefined) delete persisted.oauth;
  map[name] = persisted;
  config.mcp = map;
  return config;
}

export async function createMcpConfig(name: string, raw: unknown): Promise<McpResponseRecord> {
  if (!mcpNameOk(name)) throw new McpConfigError('MCP server name is invalid');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new McpConfigError('MCP record must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const parsed = bodyData(body);
  if (parsed.error) throw parsed.error;
  const scope = body.scope === undefined ? 'user' : body.scope;
  const directory = typeof body.directory === 'string' ? body.directory : undefined;
  const path = scopeConfigFile(scope as McpScope, directory);
  const sanitized = sanitizeMcpEntry(parsed.value);
  if (sanitized.error) throw sanitized.error;

  return withConfigLock(path, async () => {
    const config = readConfig(path, false);
    const map = mcpMap(config);
    if (tooManyServers(map)) throw new McpConfigError('MCP configuration map is full', 500);
    if (storedAt(path, name) !== undefined) {
      throw new McpConfigError(`MCP server "${name}" already exists`, 500);
    }
    const record = sanitized.value;
    await writeConfigAtomic(path, mapWith(config, name, record));
    return { ...record, name, scope: scope as McpScope };
  });
}

export async function readMcpConfig(name: string, directory: string | undefined): Promise<McpResponseRecord> {
  if (!mcpNameOk(name)) throw new McpConfigError(`MCP server "${name}" not found`, 404);
  const layer = findLayer(await readMcpLayers(directory), name);
  if (!layer) throw new McpConfigError(`MCP server "${name}" not found`, 404);
  return { ...layer.record, name, scope: layer.scope };
}

export async function updateMcpConfig(name: string, raw: unknown,
  directory: string | undefined): Promise<McpResponseRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new McpConfigError('MCP patch must be a JSON object');
  }
  const source = raw as Record<string, unknown>;
  const data = { ...source };
  delete data.scope;
  delete data.directory;
  delete data.name;
  const directoryValue = typeof source.directory === 'string' ? source.directory : directory;
  const layer = findLayer(await readMcpLayers(directoryValue), name);
  if (!layer || !mcpNameOk(name)) {
    throw new McpConfigError(`MCP server "${name}" not found`, 404);
  }
  const sanitized = sanitizeMcpEntry(data, layer.record);
  if (sanitized.error) throw sanitized.error;

  return withConfigLock(layer.path, async () => {
    const config = readConfig(layer.path, true);
    const existing = storedAt(layer.path, name);
    if (existing === undefined) throw new McpConfigError(`MCP server "${name}" not found`, 404);
    const updated = sanitizeMcpEntry(data, existing);
    if (updated.error) throw updated.error;
    const record = updated.value;
    await writeConfigAtomic(layer.path, mapWith(config, name, record));
    return { ...record, name, scope: layer.scope };
  });
}

export async function deleteMcpConfig(name: string, directory: string | undefined): Promise<void> {
  const layer = findLayer(await readMcpLayers(directory), name);
  if (!layer || !mcpNameOk(name)) throw new McpConfigError(`MCP server "${name}" not found`, 404);
  await withConfigLock(layer.path, async () => {
    const config = readConfig(layer.path, true);
    const map = mcpMap(config);
    if (!Object.hasOwn(map, name)) throw new McpConfigError(`MCP server "${name}" not found`, 404);
    delete map[name];
    if (Object.keys(map).length === 0) delete config.mcp;
    await writeConfigAtomic(layer.path, config);
  });
}

function normalizeOauth(value: unknown, fallback: McpRecord['oauth']): McpRecord['oauth'] {
  if (value !== undefined) {
    if (value === false) return false;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new McpConfigError('oauth must be an object or false');
    }
    const sanitized: Record<string, string> = {};
    for (const field of OAUTH_FIELDS) {
      const raw = (value as Record<string, unknown>)[field];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string' || raw.length > MAX_OAUTH_FIELD_BYTES || hasControlCharacters(raw)) {
        throw new McpConfigError(`oauth ${field} is invalid`);
      }
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      sanitized[field] = trimmed;
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }
  return fallback;
}

export type SanitizedMcp = Result<McpRecord>;

type Result<T> = { value: T; error?: never } | { value?: never; error: Error };

function success<T>(value: T): { value: T } { return { value }; }
function failure(error: string): { value?: never; error: Error } { return { error: new McpConfigError(error) }; }

function normalizedCommon(source: Record<string, unknown>,
  fallback?: McpRecord | null): Result<{ environment: Record<string, string>;
    enabled: boolean; oauth: McpRecord['oauth'] }> {
  const oauth = normalizeOauth(source.oauth, fallback?.oauth);
  const nextMap = (field: 'environment' | 'headers'): Record<string, string> => {
    if (!Object.hasOwn(source, field)) return { ...(fallback?.[field] ?? {}) };
    return textMap(source[field], field);
  };
  const oauthEnabled = source.oauthEnabled;
  if (oauthEnabled !== undefined && typeof oauthEnabled !== 'boolean') {
    return failure('oauthEnabled must be a boolean');
  }
  const oauthValue = oauthEnabled === true && !Object.hasOwn(source, 'oauth')
    ? (typeof fallback?.oauth === 'object' ? fallback.oauth : {})
    : oauthEnabled === false ? false : oauth;
  const enabled = source.enabled === undefined ? (fallback?.enabled ?? true) : source.enabled;
  if (typeof enabled !== 'boolean') return failure('enabled must be a boolean');
  return success({ environment: nextMap('environment'), enabled, oauth: oauthValue });
}

export function sanitizeMcpEntry(input: unknown, fallback?: McpRecord | null): Result<McpRecord> {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return failure('MCP record must be a JSON object');
    const source = input as Record<string, unknown>;
    const requestedType = source.type ?? fallback?.type;
    if (typeof requestedType !== 'string' || (requestedType !== 'local' && requestedType !== 'remote')) {
      return failure('MCP type must be local or remote');
    }
    if (source.type !== undefined && source.type !== requestedType) return failure('MCP type must be local or remote');

    const common = normalizedCommon(source, fallback);
    if (common.error) return common;
    const { environment, enabled, oauth: effectiveOauth } = common.value;

    if (requestedType === 'local') {
      const commandValue = source.command === undefined ? fallback?.command : source.command;
      if (!Array.isArray(commandValue) || commandValue.length === 0 || commandValue.length > MAX_COMMAND_ARGS) {
        return failure('command must be a non-empty bounded array');
      }
      if (commandValue.some((part) => !isBoundedArgument(part))) return failure('command is invalid');
      return success({
        type: 'local', command: [...commandValue], environment,
        enabled,
      });
    }

    const urlValue = source.url === undefined ? fallback?.url : source.url;
    if (typeof urlValue !== 'string' || urlValue.length === 0 || urlValue.length > MAX_URL || hasControlCharacters(urlValue)) {
      return failure('url is invalid');
    }
    let parsed: URL;
    try { parsed = new URL(urlValue); } catch { return failure('url is invalid'); }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
      return failure('url must use HTTP or HTTPS with a hostname');
    }
    const headers = Object.hasOwn(source, 'headers')
      ? textMap(source.headers, 'headers')
      : { ...(fallback?.headers ?? {}) };
    const timeout = source.timeout === null ? undefined
      : source.timeout === undefined ? fallback?.timeout : source.timeout;
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647)) {
      return failure('timeout must be a positive finite number');
    }
    return success({
      type: 'remote', url: urlValue,
      headers, environment, oauth: effectiveOauth,
      ...(timeout === undefined ? {} : { timeout }), enabled,
    });
  } catch (error) {
    return { error: error instanceof Error ? error : new McpConfigError('invalid MCP record') };
  }
}
