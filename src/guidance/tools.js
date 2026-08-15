// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const GUIDANCE_TOOL_TIMEOUT_MS = 5_000;
const MAX_QUERY_LENGTH = 512;
const MAX_DOCUMENT_ID_LENGTH = 256;
const TOOL_BASE = Object.freeze({ sideEffect: 'read_only', scope: 'product_guidance', cancellation: true, timeoutMs: GUIDANCE_TOOL_TIMEOUT_MS });

export function guidanceDefinitions(catalog) {
  return [searchDefinition(catalog), readDefinition(catalog)];
}

function searchDefinition(catalog) {
  return {
    name: 'nna.search_guidance', version: 1,
    purpose: 'Search canonical packaged NotNativeAgent documentation before answering questions about NNA itself.',
    ...TOOL_BASE,
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 2, maxLength: MAX_QUERY_LENGTH, description: 'Required question or topic about NotNativeAgent.' },
    }, ['query']),
    validate: async (args) => {
      requireExactStrings(args, ['query']);
      if (args.query.trim().length < 2) throw new ContractError('guidance_query_invalid', 'guidance query is too short');
      return { args: { query: args.query.trim() }, resolved: { source: 'packaged_nna_guidance' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const results = catalog.search(request.args.query);
      return {
        content: results.length > 0 ? JSON.stringify(results, null, 2) : 'No packaged guidance matched the query.',
        metadata: { query: request.args.query, matches: results.length },
      };
    },
  };
}

function readDefinition(catalog) {
  return {
    name: 'nna.read_guidance', version: 1,
    purpose: 'Read one canonical packaged NotNativeAgent guidance document selected by nna.search_guidance.',
    ...TOOL_BASE,
    inputSchema: objectSchema({
      id: { type: 'string', minLength: 1, maxLength: MAX_DOCUMENT_ID_LENGTH, description: 'Required exact document id returned by nna.search_guidance.' },
    }, ['id']),
    validate: async (args) => {
      requireExactStrings(args, ['id']);
      const document = catalog.read(args.id);
      return { args: { id: args.id }, resolved: { source: 'packaged_nna_guidance', document: document.path } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const document = catalog.read(request.args.id);
      return { content: document.content, metadata: { id: document.id, path: document.path } };
    },
  };
}

function requireExactStrings(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => typeof value[key] !== 'string')
    || Object.keys(value).some((key) => !required.includes(key))) {
    throw new ContractError('tool_schema_invalid', 'guidance tool arguments are invalid');
  }
}

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}
