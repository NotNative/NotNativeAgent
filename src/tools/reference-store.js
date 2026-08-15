// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError, newId } from '../ids.js';
import { normalizeWebUrl } from '../web-url-provenance.js';

const KINDS = new Set(['path', 'url', 'snapshot', 'draft']);
const MAX_ENTRIES = 2048;
const MAX_BYTES = 16_777_216;

export class ReferenceStore {
  #entries = new Map();
  #fingerprints = new Map();
  #bytes = 0;

  remember(kind, value, source = 'tool_observation') {
    if (!KINDS.has(kind)) throw new ContractError('reference_kind_invalid', 'reference kind is unsupported');
    const encoded = encodeValue(value);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > 1_048_576) throw new ContractError('reference_value_too_large', 'reference value exceeds 1 MiB');
    const fingerprint = `${kind}:${createHash('sha256').update(encoded).digest('hex')}`;
    const existing = this.#fingerprints.get(fingerprint);
    if (existing && this.#entries.has(existing)) return this.#entries.get(existing);
    const entry = Object.freeze({
      id: newId(`nna_ref_${kind}`), kind, value: structuredClone(value), source,
      bytes, sha256: fingerprint.slice(kind.length + 1), createdAt: Date.now(),
    });
    this.#entries.set(entry.id, entry);
    this.#fingerprints.set(fingerprint, entry.id);
    this.#bytes += bytes;
    while (this.#entries.size > MAX_ENTRIES || this.#bytes > MAX_BYTES) this.#evictOldest();
    return entry;
  }

  resolve(id, kind = null) {
    const entry = this.#entries.get(id);
    if (!entry) throw new ContractError('reference_missing', 'reference is unavailable or expired; observe or store the value again');
    if (kind && entry.kind !== kind) {
      throw new ContractError('reference_kind_mismatch', `reference must identify ${kind}; received ${entry.kind}`);
    }
    return entry;
  }

  bindArguments(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { args, bindings: [] };
    const bound = structuredClone(args);
    const bindings = [];
    for (const [field, kind] of Object.entries(REFERENCE_FIELDS)) {
      const value = bound[field];
      if (typeof value !== 'string' || !value.startsWith('nna_ref_')) continue;
      const entry = this.resolve(value, kind);
      bound[field] = entry.value;
      bindings.push(Object.freeze({ field, reference: entry.id, kind: entry.kind, source: entry.source }));
    }
    return { args: bound, bindings };
  }

  describe(id) {
    const entry = this.resolve(id);
    return Object.freeze({
      reference: entry.id, kind: entry.kind, source: entry.source,
      bytes: entry.bytes, sha256: entry.sha256, created_at: entry.createdAt,
    });
  }

  #evictOldest() {
    const id = this.#entries.keys().next().value;
    if (id === undefined) return;
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    this.#fingerprints.delete(`${entry.kind}:${entry.sha256}`);
    this.#bytes -= entry.bytes;
  }
}

const REFERENCE_FIELDS = Object.freeze({
  path: 'path', source: 'path', destination: 'path', cwd: 'path', file_path: 'path', url: 'url',
});

export function referenceDefinitions(store, paths) {
  return [storeDefinition(store, paths), inspectDefinition(store)];
}

function storeDefinition(store, paths) {
  return {
    name: 'ref.store', version: 1,
    purpose: 'Store one bounded path, URL, or draft as an ephemeral typed reference. Reuse the returned reference wherever a later tool accepts that exact path or URL string instead of reproducing values from model memory.',
    sideEffect: 'reversible', scope: 'ephemeral_reference', cancellation: true, timeoutMs: 10_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: {
        kind: { type: 'string', enum: ['path', 'url', 'draft'], description: 'Reference type: path, URL, or draft text.' },
        value: { type: 'string', maxLength: 1_048_576, description: 'Exact bounded value to retain for later tool calls.' },
      },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || !['path', 'url', 'draft'].includes(args.kind) || typeof args.value !== 'string') throw invalid();
      let value = args.value;
      if (args.kind === 'path') value = await canonicalPath(paths, value);
      if (args.kind === 'url') {
        value = normalizeWebUrl(value);
        if (!value) throw new ContractError('reference_url_invalid', 'URL reference requires a complete HTTP(S) URL without credentials');
      }
      return { args: { kind: args.kind, value }, resolved: { kind: args.kind, path: args.kind === 'path' ? value : undefined } };
    },
    executor: async (request) => {
      const entry = store.remember(request.args.kind, request.args.value, 'model_stored');
      return { content: JSON.stringify(store.describe(entry.id)), metadata: store.describe(entry.id) };
    },
  };
}

function inspectDefinition(store) {
  return {
    name: 'ref.inspect', version: 1,
    purpose: 'Inspect bounded metadata for an ephemeral typed reference without reproducing its stored value.',
    sideEffect: 'read_only', scope: 'ephemeral_reference', cancellation: true, timeoutMs: 10_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['reference'], properties: {
        reference: { type: 'string', maxLength: 180, description: 'Exact nna_ref identifier returned by a tool.' },
      },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.reference !== 'string') throw invalid();
      return { args: { reference: args.reference }, resolved: store.describe(args.reference) };
    },
    executor: async (request) => ({ content: JSON.stringify(request.resolved), metadata: request.resolved }),
  };
}

async function canonicalPath(paths, value) {
  try { return (await paths.resolveMetadata(value)).path; }
  catch (error) {
    if (!['ENOENT', 'tool_target_invalid'].includes(error.code)) throw error;
    return (await paths.resolveWrite(value)).path;
  }
}

function encodeValue(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); }
  catch { throw new ContractError('reference_value_invalid', 'reference value must be serializable'); }
}

function invalid() { return new ContractError('tool_schema_invalid', 'reference requires kind and value strings'); }
