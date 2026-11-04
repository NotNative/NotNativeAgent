// SPDX-License-Identifier: Apache-2.0
import { credentialManifest } from '../credential-bindings.js';
import { isRecord } from '../values.js';

const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/u;

// Why: the stored document separates the network identity from the model choice, so two models on
// one endpoint share one stored connection. These helpers convert between the resolved flat map and
// the stored pair of arrays.
export function providersManifest(profiles, compact, capabilitiesManifest) {
  const connections = [];
  const selections = [];
  const connectionByKey = new Map();
  for (const source of Object.values(profiles)) {
    const profile = normalizeProfile(source);
    const key = [profile.endpoint, profile.trustZone, profile.credentialKey].join('\u0000');
    let connection = connectionByKey.get(key);
    if (!connection) {
      // Why: an edited connection keeps its stored identity so selections and routes that already
      // name it stay valid. A new connection takes the next free identifier.
      connection = compact({
        id: freeConnectionId(connections, profile.preferredConnectionId),
        display_name: profile.displayName,
        endpoint: profile.endpoint,
        trust_zone: profile.trustZone,
        credential: profile.rawCredential,
        credential_env: profile.rawCredentialEnv,
      });
      connectionByKey.set(key, connection);
      connections.push(connection);
    }
    selections.push(compact({
      id: profile.id,
      connection_id: connection.id,
      model: profile.model,
      display_name: profile.displayName === connection.display_name ? undefined : profile.displayName,
      context_limit_bytes: profile.contextLimitBytes,
      output_limit_tokens: profile.outputLimitTokens,
      tool_call_mode: profile.toolCallMode === 'single' ? undefined : profile.toolCallMode,
      capabilities: capabilitiesManifest(profile.capabilities),
    }));
  }
  return { connections, model_selections: selections };
}

export function profilesFromManifest(manifest, compact) {
  const connections = Array.isArray(manifest.connections) ? manifest.connections : [];
  const selections = Array.isArray(manifest.model_selections) ? manifest.model_selections : [];
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  return selections.map((selection) => {
    const connection = byId.get(selection.connection_id) ?? {};
    return compact({
      id: selection.id,
      connection_id: selection.connection_id,
      display_name: selection.display_name ?? connection.display_name,
      endpoint: connection.endpoint,
      model: selection.model,
      trust_zone: connection.trust_zone,
      credential: connection.credential,
      credential_env: connection.credential_env,
      context_limit_bytes: selection.context_limit_bytes,
      output_limit_tokens: selection.output_limit_tokens,
      tool_call_mode: selection.tool_call_mode,
      capabilities: selection.capabilities,
    });
  });
}

// Why: this helper receives resolved camelCase profiles and the flat records read back from a stored
// document, so it normalizes both shapes once.
function normalizeProfile(source) {
  const credential = source.credential;
  const credentialEnv = source.credential_env ?? source.credentialEnv;
  // Why: a resolved profile carries a normalized binding, while a record read back from the document
  // carries snake_case keys. Both normalize to one stored reference shape.
  const rawCredential = isRecord(credential)
    ? credential.source === 'secret'
      ? { source: 'secret', secret_id: credential.secretId ?? credential.secret_id, field: credential.field }
      : undefined
    : source.rawCredential;
  const rawCredentialEnv = source.rawCredentialEnv
    ?? (credential?.source === 'environment' ? credential.name : credentialEnv ?? undefined);
  const credentialKey = rawCredential ? `secret:${rawCredential.secret_id}:${rawCredential.field}`
    : typeof rawCredentialEnv === 'string' ? `environment:${rawCredentialEnv}` : '';
  return {
    id: source.id,
    preferredConnectionId: source.connectionId ?? source.connection_id ?? boundedId(source.id),
    displayName: source.display_name ?? source.displayName ?? source.id,
    endpoint: source.endpoint,
    trustZone: source.trust_zone ?? source.trustZone,
    model: source.model,
    credentialKey,
    rawCredential,
    rawCredentialEnv,
    contextLimitBytes: source.context_limit_bytes ?? source.contextLimitBytes ?? undefined,
    outputLimitTokens: source.output_limit_tokens ?? source.outputLimitTokens ?? undefined,
    toolCallMode: source.tool_call_mode ?? source.toolCallMode,
    capabilities: source.capabilities,
  };
}

function freeConnectionId(connections, preferred) {
  const taken = new Set(connections.map((connection) => connection.id));
  if (typeof preferred === 'string' && CONNECTION_ID.test(preferred) && !taken.has(preferred)) return preferred;
  for (let index = connections.length + 1; ; index += 1) {
    const candidate = `connection_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Why: an identifier that is not a safe bounded token cannot become a stored connection id.
function boundedId(id) {
  return typeof id === 'string' && CONNECTION_ID.test(id) ? id : undefined;
}

export function credentialForManifest(profile) {
  return profile.credential?.source === 'secret' ? credentialManifest(profile.credential) : undefined;
}

// Why: one flat row per model selection so a read surface that has always shown provider rows keeps
// its shape. The stored document never carries this projection.
export function legacyProviderRows(profiles, compact, capabilitiesManifest, credentialManifest) {
  return Object.values(profiles).map((profile) => {
    const capabilities = capabilitiesManifest(profile.capabilities);
    return compact({
      id: profile.id, display_name: profile.displayName, endpoint: profile.endpoint, model: profile.model,
      trust_zone: profile.trustZone,
      credential: profile.credential?.source === 'secret' ? credentialManifest(profile.credential) : undefined,
      credential_env: profile.credential?.source === 'environment' ? profile.credential.name : profile.credentialEnv,
      context_limit_bytes: profile.contextLimitBytes ?? undefined,
      output_limit_tokens: profile.outputLimitTokens ?? undefined,
      tool_call_mode: profile.toolCallMode === 'single' ? undefined : profile.toolCallMode,
      capabilities,
    });
  });
}


