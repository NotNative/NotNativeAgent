// SPDX-License-Identifier: Apache-2.0
import { hash, json } from './nnd-install-storage.js';

/** Stable, credential-free evidence for the private ticket receipt. */
export function privateTicketEvidenceSha(identity, options, publicationSha, registrationRevision, childSha) {
  return hash(json({ operation_id: options.operationId, stage_operation_id: options.stageOperationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    generation: options.generation, publication_sha256: publicationSha,
    registration_revision: registrationRevision, child_sha256: childSha }));
}
