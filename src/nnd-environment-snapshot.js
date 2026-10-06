// SPDX-License-Identifier: Apache-2.0
/** Native environment observation (read-only).
 * Why: the census classifies seven named process-environment entries as an
 * operator_setting family whose native surface is direct observation: the settings GUI
 * must show what the selected NNA service process actually sees (presence and value for
 * the public entries, presence only for the two credential entries), instead of
 * an unguaranteed guess about shell or login scope.
 * Invariant: this family is read-only by design — environment changes happen in the
 * Windows shell or the launching supervisor, and a restart is how they reach the
 * service process; the native surface never writes environment, never exposes a
 * credential value, and never claims to observe a scope other than the service process.
 * Compatibility: the observed names are fixed by the census; unknown names are not
 * projected, so the surface shape stays stable across releases.
 */
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';

export const OBSERVED_NAMES = ['NNA_HOME', 'NNA_PROVIDER_ENDPOINT', 'NNA_MODEL',
  'NNA_REDUCED_MOTION', 'NO_COLOR', 'NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD'];
export const SECRET_NAMES = new Set(['NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD']);
// Long legal values still stay projectable: refusal (not truncation) keeps reads honest.
const MAX_VALUE_BYTES = 16384;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;

const invalid = () => new ContractError('nnd_environment_request_invalid', 'Native environment request is invalid.');
const tooLarge = () => new ContractError('nnd_environment_value_too_large',
  'An observed environment value exceeds the projection bound.');

function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(principal.subjectId) || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}

export function createNndEnvironmentSnapshot({ environment, installationId, dataId }) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw invalid();
  const identity = { installation_id: installationId, data_id: dataId, scope: 'user' };
  return Object.freeze({
    async read(principal) {
      authorize(principal, 'nnd.configuration.read');
      const observed = OBSERVED_NAMES.map((name) => {
        const raw = environment[name];
        if (raw === undefined) return { name, secret: SECRET_NAMES.has(name), present: false, value: null };
        if (SECRET_NAMES.has(name)) return { name, secret: true, present: true, value: null };
        const value = String(raw);
        if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw tooLarge();
        return { name, secret: false, present: true, value };
      });
      // The digest is computed per read over the CURRENT projected state: public values
      // plus credential presence, name-qualified so an absent entry never collides with
      // a legal sentinel value. Hashing credential values would hand readers an offline
      // guess-verification oracle. A drifted observation (env mutated mid-process) gets
      // a digest that matches what this read returned, not what the service last booted.
      const digest = createHash('sha256')
        .update(observed.map((entry) => {
          const state = entry.present ? (entry.secret ? 'present:credential' : `present:${entry.value}`) : 'absent';
          return `${entry.name}\u0000${state}`;
        }).join('\u0000'))
        .digest('hex');
      return { ...identity, schema_version: '1.0', observation_digest: digest, observed,
        environment_scope: 'service_process' };
    },
  });
}
