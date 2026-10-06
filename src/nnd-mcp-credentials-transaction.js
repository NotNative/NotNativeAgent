// SPDX-License-Identifier: Apache-2.0
/** Native managed-MCP-credential settings service over config/mcp-credentials.json.
 * Why: census row managed_mcp_credentials:credentials.{NNA_MCP_MANAGED_reference} needs
 * an authenticated native surface over the store the engine host applies to MCP server
 * environments (src/mcp-credentials.js owns the grammar: sticky-absent
 * {format_version:1,credentials:{}} under 1 MiB, ≤256 references, tokens 1-16,384 chars
 * with no CR/LF/NUL, session-locked atomic writes, and reference
 * NNA_MCP_MANAGED_<stem>_<sha256:12>_TOKEN).
 * Invariants: token values never project — reads list references with an `applied`
 * presence flag only; save returns the derived reference and a receipt that never
 * echoes the token; delete of a foreign reference is an honest no-op receipt
 * (persistence 'absent'), matching the trust family's gone-root semantics. The service
 * runs the domain's own functions verbatim so lock, bound, and grammar behavior stays
 * native; receipts carry application 'next_server_spawn' because the credential only
 * reaches MCP workers through the environment of their next spawn. There is no
 * operation-ledger endpoint in this family: save is an upsert (idempotent by
 * construction) and delete is idempotent, so receipts claim nothing about replay.
 */
import { ContractError } from './ids.js';
import {
  deleteManagedMcpCredential, isManagedMcpCredentialReference, listManagedMcpCredentials,
  saveManagedMcpCredential,
} from './mcp-credentials.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { lstat } from 'node:fs/promises';

const invalid = () => new ContractError('nnd_mcp_credentials_request_invalid', 'Native MCP credential request is invalid.');
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION = /^[A-Za-z0-9_-]{1,64}$/u;
const SERVER = /^[\u0021-\u007e]{1,128}$/u;

/** Defense in depth: the HTTP route checks the same rights; the service repeats them
 * so any other caller of the transaction enforcement stays at parity. */
function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(principal.subjectId) || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}

function normalize(input, identity, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const keys = ['installation_id', 'data_id', 'scope', ...Object.keys(fields), 'operation_id'];
  if (Object.keys(input).some((key) => !keys.includes(key))
    || Object.entries(identity).some(([key, value]) => input[key] !== value)
    || !OPERATION.test(input.operation_id ?? '')) throw invalid();
  for (const [key, pattern] of Object.entries(fields)) {
    if (!pattern.test(String(input[key] ?? ''))) throw invalid();
  }
  return input;
}

export function createNndMcpCredentialsService({ paths, installationId, dataId, environment }) {
  if (!paths || typeof paths.mcpCredentials !== 'string'
    || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw invalid();
  const identity = Object.freeze({ installation_id: installationId, data_id: dataId, scope: 'user' });
  return Object.freeze({
    async read(principal) {
      authorize(principal, 'nnd.configuration.read');
      // Token presence in the environment is reported per reference: the applied flag
      // says the engine host's env carries the credential key for the next MCP spawn.
      const sourceState = await lstat(paths.mcpCredentials).then(() => 'present').catch((error) => {
        if (error?.code === 'ENOENT') return 'absent';
        throw error;
      });
      const list = await listManagedMcpCredentials(paths, environment);
      return { ...identity, source_state: sourceState, count: list.count,
        credentials: list.credentials, application: 'next_server_spawn' };
    },
    async save(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, { server_id: SERVER, token: /.*/u });
      const reference = await saveManagedMcpCredential(paths, request.server_id, request.token, environment);
      return { ...identity, operation_id: request.operation_id, persistence: 'saved', reference,
        application: 'next_server_spawn', next_action: 'inspect_native_operation' };
    },
    async remove(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, { reference: /.*/u });
      if (!isManagedMcpCredentialReference(String(request.reference ?? ''))) throw invalid();
      const removed = await deleteManagedMcpCredential(paths, request.reference, environment);
      return { ...identity, operation_id: request.operation_id,
        persistence: removed ? 'deleted' : 'absent', reference: request.reference,
        application: 'next_server_spawn', next_action: 'inspect_native_operation' };
    },
  });
}
