// SPDX-License-Identifier: Apache-2.0
/** Provider credential-binding and capability observation.
 * Why: the thirteen census manifest_provider rows describe a provider's
 * credential BINDING (which source, which environment name, which secret id and
 * field), the credential container, the compatibility credential_env alias, and
 * the capability flags. None of them is a secret value: a binding names where a
 * credential lives, and the values stay in the Secret Broker vault or the
 * process environment. This surface reads the manifest exactly the way the CLI
 * does (readManifestSnapshot plus resolveManifest) and reuses credentialManifest
 * for the wire shape, so no projection code re-derives a binding and none can
 * invent a field the domain does not have.
 * Invariant: the permission check runs before any disk work; values never appear
 * in the projection; a manifest that will not resolve fails with the resolver's
 * own codes rather than serving a partial view; and provider mutation stays with
 * the manifest transaction that writes with an expected revision.
 */
import { resolveManifest } from './config.js';
import { credentialManifest } from './credential-bindings.js';
import { readManifestSnapshot } from './persistence/manifest-transaction.js';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { join } from 'node:path';

const MAX_PROVIDERS = 32;
// The same location provider/bootstrap.js and the CLI read: the user manifest
// beside the other service state, not a path this module invents.
const MANIFEST_FILE = 'manifest.json';

export function createNndProviderObservation({ paths, installationId, dataId,
  readSnapshot = readManifestSnapshot } = {}) {
  if (!paths || typeof paths.config !== 'string' || typeof installationId !== 'string'
    || typeof dataId !== 'string') {
    throw new ContractError('nnd_provider_observation_request_invalid',
      'Native provider observation requires a configuration path and an installation identity.');
  }
  const manifestPath = join(paths.config, MANIFEST_FILE);
  return Object.freeze({
    async read(principal) {
      requireIntegrationPermission(principal, 'nnd.configuration.read');
      const snapshot = await readSnapshot(manifestPath);
      if (!snapshot || snapshot.state === 'missing' || !snapshot.rawManifest) {
        return { schema_version: '1.0', installation_id: installationId, data_id: dataId, scope: 'user',
          source_state: 'absent', manifest_revision: 'absent', providers: [] };
      }
      const profiles = resolveManifest(snapshot.rawManifest)?.providerProfiles ?? {};
      const entries = Object.entries(profiles);
      // Legal state cannot reach this: the manifest key grammar is bounded and
      // a wider profile set is a projection the response bound could not carry.
      if (entries.length > MAX_PROVIDERS) {
        throw new ContractError('nnd_provider_observation_projection_invalid',
          'Native provider observation refused an unbounded profile set.');
      }
      return { schema_version: '1.0', installation_id: installationId, data_id: dataId, scope: 'user',
        source_state: 'present', manifest_revision: snapshot.revision ?? 'absent',
        providers: entries.map(([id, profile]) => ({
          id,
          model: profile.model,
          endpoint: profile.endpoint,
          trust_zone: profile.trustZone,
          credential: credentialManifest(profile.credential) ?? null,
          credential_env: profile.credentialEnv ?? null,
          capabilities: {
            streaming: profile.capabilities.streaming === true,
            tools: profile.capabilities.tools === true,
            images: profile.capabilities.images === true,
            structured_output: profile.capabilities.structuredOutput === true,
            usage: profile.capabilities.usage === true,
            cancellation: profile.capabilities.cancellation === true,
          },
        })) };
    },
  });
}
