// SPDX-License-Identifier: Apache-2.0
/** Native installation-identity observation over the verified descriptor.
 * The census classifies six install.json rows (product, version,
 * install_root, data_root, node, node_major) as generated_state: the
 * descriptor is installer-written and service-admitted, never
 * operator-editable. The read re-verifies the descriptor on disk through the
 * admission authority (readNndServiceIdentity — descriptor validation,
 * payload check, runtime probe) and projects the verified values, so a
 * drifted or missing descriptor fails closed: a handler must not project an
 * admission the disk no longer supports (the -3 environment-route stance),
 * and the operator repairs the installation instead.
 */
import { readNndServiceIdentity } from './nnd-service-identity.js';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';

// Projected field names in census family order; the identity admission has
// verified every projected value.
export const OBSERVED_DESCRIPTOR = Object.freeze(['product', 'version', 'install_root',
  'data_root', 'node', 'node_major']);

export function createNndInstallationSnapshot({ installRoot, installationId, dataId, readIdentity = readNndServiceIdentity }) {
  if (typeof installRoot !== 'string' || installRoot.length === 0
    || !ID_DEFINED.test(installationId ?? '') || !ID_DEFINED.test(dataId ?? '')
    || typeof readIdentity !== 'function') {
    throw new ContractError('nnd_installation_request_invalid', 'Native installation observation is unavailable.');
  }
  return Object.freeze({
    async read(principal) {
      requireIntegrationPermission(principal, 'nnd.configuration.read');
      try {
        const verified = await readIdentity(installRoot);
        return { schema_version: '1.0', installation_id: installationId, data_id: dataId,
          scope: 'user', product: 'NotNativeAgent', version: verified.version,
          install_root: verified.install_root, data_root: verified.data_root,
          node: verified.node, node_major: verified.node_major };
      } catch (error) {
        // The descriptor authority throws the honest nnd_install_* ContractErrors;
        // a non-contract failure is the descriptor being unreadable — the same
        // honest verdict, never rebranded by the router into a generic 503 text.
        if (error instanceof ContractError) throw error;
        throw new ContractError('nnd_install_descriptor_unavailable', 'NNA installation descriptor could not be read.');
      }
    },
  });
}
const ID_DEFINED = /^[A-Za-z0-9_-]{1,128}$/u;
