// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { isRecord } from '../values.js';
import { normalizeCredentialBinding } from '../credential-bindings.js';
import { providerToolCallMode } from './tool-call-mode.js';

const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/u;

// Why: the stored document keeps the network identity and the model choice apart, so one endpoint
// can serve several selectable models. These helpers resolve that pair into the flat provider map.
export function validateConnections(manifest, { parseEndpoint, endpointZone, trustZones, scalar, capability }) {
  const connections = manifest.connections;
  if (connections.length === 0 || connections.length > 16) {
    throw new ContractError('invalid_providers', 'one to sixteen connections are required');
  }
  const selections = Array.isArray(manifest.model_selections) ? manifest.model_selections : [];
  if (selections.length === 0 || selections.length > 64) {
    throw new ContractError('invalid_model_selection', 'one to sixty-four model selections are required');
  }
  const base = Object.create(null);
  for (const value of connections) {
    const record = validateConnection(value, { parseEndpoint, endpointZone, trustZones });
    if (Object.hasOwn(base, record.id)) throw new ContractError('duplicate_provider', `duplicate connection ${record.id}`);
    base[record.id] = record;
  }
  const result = Object.create(null);
  for (const value of selections) {
    const selection = validateSelection(value);
    const connection = base[selection.connectionId];
    if (!connection) {
      throw new ContractError('invalid_model_selection', `selection names an unknown connection ${selection.connectionId}`);
    }
    const profile = { ...connection, ...selectionFields(selection, connection, { scalar, capability }), connectionId: connection.id };
    if (Object.hasOwn(result, profile.id)) throw new ContractError('duplicate_provider', `duplicate provider ${profile.id}`);
    result[profile.id] = profile;
  }
  return result;
}

function validateConnection(value, { parseEndpoint, endpointZone, trustZones }) {
  if (!isRecord(value)) throw new ContractError('missing_provider', 'manifest connection is required');
  if (typeof value.id !== 'string' || !CONNECTION_ID.test(value.id)) {
    throw new ContractError('provider_id_invalid', 'connection id must use one to 64 letters, numbers, underscores, or hyphens');
  }
  const endpoint = parseEndpoint(value.endpoint);
  const expectedZone = endpointZone(endpoint);
  if (!trustZones.has(value.trust_zone) || value.trust_zone !== expectedZone) {
    throw new ContractError('invalid_trust_zone', `endpoint requires trust zone ${expectedZone}`);
  }
  const credentialEnv = optionalString(value.credential_env);
  const credential = normalizeCredentialBinding(value.credential, credentialEnv);
  // Why: a connection keeps every field it stored so a resolve/write round trip keeps the operator's
  // credential binding, even when it is a reference this reader does not resolve.
  return {
    id: value.id,
    displayName: optionalString(value.display_name) ?? value.id,
    endpoint: endpoint.href.replace(/\/$/u, ''),
    trustZone: value.trust_zone,
    credential, credentialEnv: credential?.source === 'environment' ? credential.name : credentialEnv,
    rawCredential: isRecord(value.credential) ? { ...value.credential } : undefined,
    rawCredentialEnv: typeof value.credential_env === 'string' ? value.credential_env : undefined,
  };
}

function validateSelection(value) {
  if (!isRecord(value)) throw new ContractError('invalid_model_selection', 'manifest model selection is required');
  if (typeof value.connection_id !== 'string' || !CONNECTION_ID.test(value.connection_id)) {
    throw new ContractError('invalid_model_selection', 'selection connection id must be a bounded identifier');
  }
  if (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 256) {
    throw new ContractError('invalid_model', 'selection model is required and bounded');
  }
  const id = typeof value.id === 'string' ? value.id : `${value.connection_id}-${value.model}`.slice(0, 64);
  if (!CONNECTION_ID.test(id)) {
    throw new ContractError('provider_id_invalid', 'selection id must use one to 64 letters, numbers, underscores, or hyphens');
  }
  return { id, connectionId: value.connection_id, model: value.model, record: value };
}

function selectionFields(selection, connection, { scalar, capability }) {
  const value = selection.record;
  return {
    id: selection.id,
    displayName: optionalString(value.display_name) ?? connection.displayName,
    model: selection.model,
    contextLimitBytes: scalar('model_selections[*].context_limit_bytes', value.context_limit_bytes),
    outputLimitTokens: scalar('model_selections[*].output_limit_tokens', value.output_limit_tokens),
    toolCallMode: providerToolCallMode(value.tool_call_mode),
    capabilities: Object.freeze({
      streaming: true,
      tools: capability(value.capabilities?.tools),
      images: capability(value.capabilities?.images),
      structuredOutput: capability(value.capabilities?.structured_output),
      usage: capability(value.capabilities?.usage),
      cancellation: capability(value.capabilities?.cancellation),
    }),
  };
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
