// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function secretReferences(config, id) {
  const references = [];
  for (const profile of Object.values(config.providerProfiles ?? {})) {
    if (profile.credential?.source === 'secret' && profile.credential.secretId === id) {
      references.push(Object.freeze({ kind: 'provider', id: profile.id, label: `Provider ${profile.displayName}` }));
    }
  }
  for (const server of config.mcpServers ?? []) {
    if (server.credential?.source === 'secret' && server.credential.secretId === id) {
      references.push(Object.freeze({ kind: 'mcp', id: server.id, label: `MCP ${server.id}` }));
    }
    for (const [header, binding] of Object.entries(server.headerCredentials ?? {})) {
      if (binding.source === 'secret' && binding.secretId === id) {
        references.push(Object.freeze({ kind: 'mcp', id: server.id, label: `MCP ${server.id} header ${header}` }));
      }
    }
  }
  return references;
}

export async function listSecretsWithReferences(broker, config) {
  return (await broker.list()).map((secret) => Object.freeze({
    ...secret, references: Object.freeze(secretReferences(config, secret.id)),
  }));
}

export function deleteUnreferencedSecret(broker, config, id) {
  const references = secretReferences(config, id);
  if (references.length > 0) {
    throw new ContractError('secret_in_use', `Secret is used by ${references.map((item) => item.label).join(', ')}. Remove those bindings first.`);
  }
  return broker.remove(id);
}
