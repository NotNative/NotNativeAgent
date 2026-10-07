// SPDX-License-Identifier: Apache-2.0
/** Native invocation vocabulary route over /v1/nnd/configuration/invocation.
 * Why: the 23 invocation:* census rows are operator_action rows over the CLI
 * flag grammar (validator parseCli, store invocation_arguments). The native
 * surface is a READ of the flag vocabulary the -21 slice added to
 * cli-options.js (INVOCATION_VOCABULARY): one projected entry per census
 * row — flag, aliases, argument grammar, allowed modes, host/headless
 * refusal, the parsed option key, and the operator-facing effect. The flags
 * themselves stay CLI-owned (the vocabulary is what the operator types at
 * the terminal; the native surface only DESCRIBES it honestly); the
 * mechanical consistency test proves the table against parseCli behavior,
 * so description cannot drift from the parser. The HEAD vocabulary is not
 * the factory itself; the service receives it as a constructor argument so
 * the factory validation stays uniform with the other native services.
 */
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { INVOCATION_VOCABULARY } from './cli-options.js';

const BASE = '/v1/nnd/configuration/invocation';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const invalid = () => new ContractError('nnd_invocation_request_invalid', 'Native invocation request is invalid.');
const projection = () => new ContractError('nnd_invocation_projection_invalid', 'Native invocation projection refused a drifted vocabulary.');

const REJECT = new Set(['--provider-endpoint', '--model', '--provider-credential-env']);

export function createNndInvocationService({ installationId, dataId }) {
  if (!ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw invalid();
  return Object.freeze({
    read: async () => Object.freeze({ schema_version: '1.0', installation_id: installationId,
      data_id: dataId, scope: 'user', family: 'invocation', application: 'not_applied',
      modes: INVOCATION_VOCABULARY.modes, flags: INVOCATION_VOCABULARY.flags }),
  });
}

export function projectInvocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'application,data_id,family,flags,'
      + 'installation_id,modes,schema_version,scope'
    || value.schema_version !== '1.0' || typeof value.installation_id !== 'string'
    || !ID.test(value.installation_id) || typeof value.data_id !== 'string'
    || !ID.test(value.data_id) || value.scope !== 'user' || value.family !== 'invocation'
    || value.application !== 'not_applied'
    || !Array.isArray(value.modes) || value.modes.length < 1
    || value.modes.some((mode) => typeof mode !== 'string')) throw projection();
  if (value.flags.length !== 23) throw projection();
  for (const flag of value.flags) {
    if (!flag || typeof flag !== 'object' || Array.isArray(flag)
      || Object.keys(flag).sort().join(',') !== 'aliases,argument,effect,flag,headless,modes,option'
      || typeof flag.flag !== 'string' || flag.flag.length === 0
      || !Array.isArray(flag.aliases) || flag.aliases.some((a) => typeof a !== 'string')
      || !['value', 'none', 'prompt-text'].includes(flag.argument)
      || (flag.modes !== '*' && (!Array.isArray(flag.modes) || flag.modes.length === 0
        || flag.modes.some((m) => typeof m !== 'string')))
      || typeof flag.headless !== 'boolean' || typeof flag.effect !== 'string'
      || flag.effect.length === 0
      || (flag.option !== null && (typeof flag.option !== 'string' || flag.option.length === 0))) {
      throw projection();
    }
    if (REJECT.has(flag.flag) && flag.modes === '*' && flag.headless !== false) throw projection();
  }
  return value;
}

const RESPONSE_BYTES = 16_384;

export async function dispatchNndInvocationRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE) return false;
  if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (context.url.search) throw invalid();
  const service = context.nndInvocationService;
  if (!service || typeof service.read !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native invocation vocabulary is unavailable.');
  }
  const projected = projectInvocation(await service.read());
  if (Buffer.byteLength(JSON.stringify(projected)) > RESPONSE_BYTES) throw invalid();
  return send(response, 200, projected);
}
