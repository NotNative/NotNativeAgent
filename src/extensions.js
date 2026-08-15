// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export const EXTENSION_HOST_CONTRACT = '1.0';
const MAX_DIAGNOSTICS = 256;
const MAX_NAMES = 128;
const MIN_SHUTDOWN_TIMEOUT_MS = 100;
const MAX_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_JSON_BYTES = 65_536;
const MAX_TEXT_LENGTH = 512;

export class ExtensionRegistry {
  #extensions = new Map();
  #diagnostics = [];
  #operations = new Map();

  install(manifest, factory) {
    const normalized = normalizeManifest(manifest);
    if (typeof factory !== 'function') throw new ContractError('invalid_extension_factory', 'extension factory must be callable');
    if (this.#extensions.has(normalized.id)) throw new ContractError('extension_collision', 'extension id is already installed');
    const compatible = normalized.host_contract_version === EXTENSION_HOST_CONTRACT;
    this.#extensions.set(normalized.id, {
      manifest: normalized, factory, instance: null, controller: null,
      state: compatible ? 'installed' : 'incompatible',
      diagnostic: compatible ? null : `host contract ${normalized.host_contract_version} is incompatible with ${EXTENSION_HOST_CONTRACT}`,
    });
    return this.inspect(normalized.id);
  }

  enable(id, confirmation) {
    const extension = this.#required(id);
    if (confirmation !== `enable:${id}`) {
      throw new ContractError('extension_enable_confirmation_required', `confirm extension capabilities with enable:${id}`);
    }
    if (extension.state === 'incompatible') return this.inspect(id);
    if (extension.state === 'ready') return this.inspect(id);
    if (['disabling', 'unloading'].includes(extension.state)) {
      throw new ContractError('extension_transition_busy', 'extension lifecycle transition is already in progress');
    }
    const controller = new AbortController();
    const api = Object.freeze({
      host_contract_version: EXTENSION_HOST_CONTRACT,
      signal: controller.signal,
      emitDiagnostic: (code, details = {}) => this.#recordDiagnostic(id, code, details),
    });
    try {
      const instance = extension.factory(api);
      if (instance && typeof instance.then === 'function') {
        throw new ContractError('extension_async_factory_unsupported', 'extension factory initialization must be synchronous');
      }
      extension.instance = instance ?? Object.freeze({});
      extension.controller = controller;
      extension.state = 'ready';
      extension.diagnostic = null;
    } catch (error) {
      controller.abort('extension_initialization_failed');
      extension.state = 'failed';
      extension.diagnostic = safeFailure(error);
      this.#recordDiagnostic(id, 'extension_initialization_failed', { message: extension.diagnostic });
    }
    return this.inspect(id);
  }

  register(manifest, factory) {
    const installed = this.install(manifest, factory);
    if (manifest.enabled !== true) return installed;
    return this.enable(installed.id, `enable:${installed.id}`);
  }

  async disable(id) {
    return this.#enqueue(id, () => this.#disable(id));
  }

  async unload(id) {
    return this.#enqueue(id, async () => {
      const extension = this.#extensions.get(id);
      if (!extension) return false;
      if (extension.state === 'ready' || extension.instance) await this.#disable(id, 'unloading');
      this.#extensions.delete(id);
      return true;
    });
  }

  inspect(id) { return present(this.#required(id)); }

  list() { return Object.freeze([...this.#extensions.values()].map(present)); }

  capabilities() {
    return Object.freeze([...this.#extensions.values()]
      .filter((extension) => extension.state === 'ready' && extension.instance)
      .flatMap((extension) => extension.manifest.capabilities.map((capability) => Object.freeze({
        extension_id: extension.manifest.id, capability,
      }))));
  }

  diagnostics() { return Object.freeze(this.#diagnostics.map((item) => Object.freeze({ ...item }))); }

  async close() {
    const active = [...this.#extensions.values()]
      .filter((extension) => extension.state === 'ready' || extension.instance)
      .map((extension) => extension.manifest.id);
    await Promise.allSettled(active.map((id) => this.disable(id)));
    return this.list();
  }

  #recordDiagnostic(id, code, details) {
    const safe = Object.freeze({ extension_id: id, code: boundedText(code), details: safeDetails(details) });
    this.#diagnostics.push(safe);
    if (this.#diagnostics.length > MAX_DIAGNOSTICS) this.#diagnostics.shift();
  }

  #required(id) {
    const value = this.#extensions.get(id);
    if (!value) throw new ContractError('extension_missing', `extension ${id} is not installed`);
    return value;
  }

  async #disable(id, transition = 'disabling') {
    const extension = this.#required(id);
    extension.state = transition;
    extension.controller?.abort('extension_disabled');
    const closeFailure = await closeBounded(extension);
    extension.instance = null;
    extension.controller = null;
    extension.state = closeFailure ? 'failed' : 'disabled';
    extension.diagnostic = closeFailure;
    if (closeFailure) this.#recordDiagnostic(id, 'extension_close_failed', { message: closeFailure });
    return this.inspect(id);
  }

  #enqueue(id, operation) {
    const prior = this.#operations.get(id) ?? Promise.resolve();
    const pending = prior.then(operation, operation);
    this.#operations.set(id, pending);
    return pending.finally(() => {
      if (this.#operations.get(id) === pending) this.#operations.delete(id);
    });
  }
}

function normalizeManifest(value) {
  if (!value || typeof value !== 'object' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(value.id ?? '')
    || !bounded(value.origin) || !bounded(value.version) || !bounded(value.license)
    || !bounded(value.host_contract_version) || !Array.isArray(value.capabilities)
    || !Array.isArray(value.permissions) || !plainObject(value.configuration_schema)
    || !plainObject(value.lifecycle)) {
    throw new ContractError('invalid_extension_manifest', 'extension manifest lacks bounded identity, provenance, host contract, schema, permissions, or lifecycle');
  }
  if (value.download_url || value.auto_discover || value.update_url) {
    throw new ContractError('extension_implicit_install_forbidden', 'extensions cannot download, update, or auto-discover code');
  }
  const capabilities = boundedNames(value.capabilities, 'capability');
  const permissions = boundedNames(value.permissions, 'permission');
  const shutdown = value.lifecycle.shutdown_timeout_ms ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(shutdown) || shutdown < MIN_SHUTDOWN_TIMEOUT_MS || shutdown > MAX_SHUTDOWN_TIMEOUT_MS) {
    throw new ContractError('invalid_extension_manifest', 'extension shutdown timeout must be 100 to 30000 milliseconds');
  }
  const configuration = cloneJson(value.configuration_schema, 'configuration schema');
  return Object.freeze({
    id: value.id, origin: value.origin, version: value.version, license: value.license,
    host_contract_version: value.host_contract_version,
    capabilities: Object.freeze(capabilities), permissions: Object.freeze(permissions),
    configuration_schema: configuration,
    lifecycle: Object.freeze({ shutdown_timeout_ms: shutdown }),
  });
}

function present(extension) {
  const manifest = extension.manifest;
  return Object.freeze({
    id: manifest.id, origin: manifest.origin, version: manifest.version, license: manifest.license,
    host_contract_version: manifest.host_contract_version,
    capabilities: Object.freeze([...manifest.capabilities]), permissions: Object.freeze([...manifest.permissions]),
    configuration_schema: manifest.configuration_schema, lifecycle: manifest.lifecycle,
    state: extension.state, diagnostic: extension.diagnostic,
  });
}

async function closeBounded(extension) {
  if (typeof extension.instance?.close !== 'function') return null;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => extension.instance.close()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('extension close exceeded its deadline')), extension.manifest.lifecycle.shutdown_timeout_ms);
      }),
    ]);
    return null;
  } catch (error) { return safeFailure(error); }
  finally { clearTimeout(timer); }
}

function boundedNames(values, label) {
  if (values.length > MAX_NAMES || values.some((item) => !/^[A-Za-z0-9_.:-]{1,128}$/u.test(item ?? ''))) {
    throw new ContractError('invalid_extension_manifest', `extension ${label} list is invalid or unbounded`);
  }
  return [...new Set(values)];
}

function cloneJson(value, label) {
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw new Error(`${label} is too large`);
    return deepFreeze(JSON.parse(encoded));
  } catch (error) { throw new ContractError('invalid_extension_manifest', `${label} must be bounded JSON: ${safeFailure(error)}`); }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return value && typeof value === 'object' ? Object.freeze(value) : value;
}

function safeDetails(value) {
  try { return cloneJson(value, 'diagnostic details'); }
  catch { return Object.freeze({ message: 'diagnostic details rejected' }); }
}
function safeFailure(error) { return boundedText(error?.message ?? 'extension operation failed'); }
function boundedText(value) { return String(value).replace(/[\r\n\t]/gu, ' ').slice(0, MAX_TEXT_LENGTH); }
function bounded(value) { return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH; }
function plainObject(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
