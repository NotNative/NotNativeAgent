// SPDX-License-Identifier: Apache-2.0
/** Native legacy provider-credential store observation route over
 * /v1/nnd/configuration/legacy-provider-credentials. Why: the
 * legacy_provider_credentials census family cites
 * src/provider/bootstrap.js loadManagedProviderCredentials, the startup
 * alias loader that validates config/provider-credentials.json
 * ({format_version:1, credentials:{NNA_PROVIDER_INITIAL_KEY: string ≤16 KiB}})
 * and injects the legacy environment key into the serving process (only if
 * unset) at every CLI startup. This surface runs that authority verbatim
 * against a SPARE environment object and projects the verdict WITHOUT the
 * value: GET reports a loaded alias (loaded:true, count:1), an absent store
 * (190873loaded:false, count:0), or the authority's own honest refusal
 * (registered shape codes), and never projects the value of
 * NNA_PROVIDER_INITIAL_KEY. Nothing on disk changes; the values land in the
 * spare environment, which is discarded. Projector drift is the 500
 * nnd_legacy_provider_credentials_projection_invalid; transport grammar is
 * nnd_legacy_provider_credentials_request_invalid (400).
 */
import { resolve } from 'node:path';
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { loadManagedProviderCredentials } from './provider/bootstrap.js';

const BASE = '/v1/nnd/configuration/legacy-provider-credentials';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const RESPONSE_BOUND = 8_192;
const invalid = () => new ContractError('nnd_legacy_provider_credentials_request_invalid',
  'Native legacy provider credential request is invalid.');
const projection = () => new ContractError('nnd_legacy_provider_credentials_projection_invalid',
  'Native legacy provider credential observation refused a drifted projection.');

export function createNndLegacyProviderCredentialsService({ paths, installationId, dataId,
  loader = loadManagedProviderCredentials }) {
  if (typeof paths?.providerCredentials !== 'string'
    || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw invalid();
  return Object.freeze({
    async status() {
      const environment = {};
      try { await loader(paths, environment); }
      catch (error) {
        if (error instanceof ContractError
          && (error.code === 'provider_bootstrap_file_too_large'
            || error.code === 'provider_credentials_invalid')) {
          return Object.freeze({ schema_version: '1.0', installation_id: installationId,
            data_id: dataId, scope: 'user', loaded: false, count: 0,
            reason: error.code });
        }
        throw error;
      }
      const count = typeof environment.NNA_PROVIDER_INITIAL_KEY === 'string'
        ? 1 : 0;
      return Object.freeze({ schema_version: '1.0', installation_id: installationId,
        data_id: dataId, scope: 'user', loaded: count === 1, count, reason: null });
    },
  });
}

export function projectLegacyProviderCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'count,data_id,installation_id,loaded,'
      + 'reason,schema_version,scope'
    || value.schema_version !== '1.0'
    || typeof value.installation_id !== 'string' || !ID.test(value.installation_id)
    || typeof value.data_id !== 'string' || !ID.test(value.data_id)
    || value.scope !== 'user' || typeof value.loaded !== 'boolean'
    || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 1
    || (value.reason !== null && value.reason !== 'provider_bootstrap_file_too_large'
      && value.reason !== 'provider_credentials_invalid')
    || (value.loaded === true && (value.count !== 1 || value.reason !== null))
    || (value.loaded === false && value.count !== 0)) throw projection();
  return { schema_version: '1.0', installation_id: value.installation_id,
    data_id: value.data_id, scope: 'user', loaded: value.loaded, count: value.count,
    reason: value.reason };
}

export async function dispatchNndLegacyProviderCredentialsRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (path === BASE) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    const service = context.nndLegacyProviderCredentialsService;
    if (!service || typeof service.status !== 'function') {
      throw new ContractError('nnd_configuration_unavailable', 'Native legacy provider credential observation is unavailable.');
    }
    const receipt = projectLegacyProviderCredentials(await service.status());
    if (Buffer.byteLength(JSON.stringify(receipt)) > RESPONSE_BOUND) throw invalid();
    return send(response, 200, receipt);
  }
  return send(response, 404, { error: 'not_found' });
}
