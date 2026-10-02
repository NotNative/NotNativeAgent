// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { ContractError, requireExternalId } from './ids.js';
import { recoverJournal } from './store.js';
import { userDataPaths } from './product.js';
import { validateSessionLineage } from './session-lineage.js';
import { isDeepStrictEqual } from 'node:util';
import { supportDiagnosticSummary } from './support-diagnostic-fields.js';

const MAX_SESSIONS = 63;
const DISCOVERY_RECORD_TYPES = new Set(['session_created', 'subagent_session']);

export async function discoverSupportSessions(seeds) {
  const sessions = seeds.map((session) => ({ ...session, id: session.id ?? session.engine.sessionId }));
  for (const session of sessions) requireExternalId(session.id, 'session_id');
  const seen = new Set(sessions.map((session) => session.id));
  if (sessions.length > MAX_SESSIONS) throw new ContractError('zip_entries_invalid', 'support session count exceeds the archive bound');
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]; const rootEngine = session.sourceEngine ?? session.engine;
    const journal = session.journal ?? await supportJournal(rootEngine.storeRoot, `${session.id}.journal.ndjson`, DISCOVERY_RECORD_TYPES);
    session.journal = journal;
    const relations = new Map([...rootEngine.childSessions?.values() ?? []].filter((value) => value.parent_session_id === session.id)
      .map((value) => [value.child_session_id, value]));
    for (const record of journal.records) if (record.type === 'subagent_session') {
      relations.set(record.payload.child_session_id, record.payload);
    }
    session.discovery = { ...journal.coverage, association_basis: 'explicit_parent_journal_links',
      historical_associations: journal.records[0]?.payload?.session_lineage_schema === 'nna.session-lineage.v1'
        ? 'recorded' : 'unknown' };
    for (const relation of relations.values()) {
      const lineage = validateSessionLineage(relation, relation.child_session_id);
      if (lineage.parent_session_id !== session.id || seen.has(lineage.child_session_id)) continue;
      if (sessions.length >= MAX_SESSIONS) throw new ContractError('zip_entries_invalid', 'related sessions exceed the archive bound');
      const childJournal = await supportJournal(rootEngine.storeRoot, `${lineage.child_session_id}.journal.ndjson`, DISCOVERY_RECORD_TYPES);
      const header = childJournal.records[0]?.payload;
      if (header && (header.sessionId !== lineage.child_session_id
        || !isDeepStrictEqual(validateSessionLineage(header.lineage, lineage.child_session_id), lineage))) {
        throw new ContractError('session_history_invalid', 'child journal lineage does not match its parent');
      }
      seen.add(lineage.child_session_id);
      sessions.push({ id: lineage.child_session_id, lineage, state: relation.state, sourceEngine: rootEngine,
        journal: childJournal, engine: archivedSessionEngine(rootEngine, lineage, relation.state, header) });
    }
  }
  return sessions;
}

function archivedSessionEngine(rootEngine, lineage, state, header) {
  return {
    sessionId: lineage.child_session_id, sessionLineage: lineage, config: null,
    diagnosticConfiguration: header?.diagnostic_configuration ?? { status: 'historical_configuration_unavailable' },
    health: async () => ({ status: 'archived_observation', lifecycle_state: state }),
    reviewerAudit: () => [], governanceAudit: () => [],
    telemetry: { flush: async () => rootEngine.telemetry?.flush?.(),
      supportSnapshot: (options) => rootEngine.telemetry?.supportSnapshot?.({ ...options, sessionId: lineage.child_session_id }) },
  };
}

export async function supportJournal(root, name, retainedTypes = null) {
  if (!root) return { records: [], coverage: { complete: false, reason: 'journal_not_available' } };
  try {
    const path = join(root, name); const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new ContractError('session_history_invalid', 'support journal is not a regular file');
    const recovered = await recoverJournal(path, { maxBytes: 67108864 });
    return { records: recovered.records.filter((record) => !retainedTypes || retainedTypes.has(record.type))
      .map(({ sequence, type, payload }) => ({ sequence, type, payload })),
      coverage: { complete: !recovered.corruptTail, basis: 'retained_journal', records: recovered.records.length,
        reason: recovered.corruptTail ? 'corrupt_tail' : null } };
  } catch (error) { return { records: [], coverage: { complete: false, reason: error.code ?? 'journal_read_failed' } }; }
}

export async function supportAuditJournals(session) {
  requireExternalId(session.id, 'session_id');
  const engine = session.sourceEngine ?? session.engine;
  if (!engine.store) return { reviewer: { records: [], coverage: { complete: false, reason: 'not_durable' } },
    governance: { records: [], coverage: { complete: false, reason: 'not_durable' } } };
  const roots = engine.subagentOptions ?? {}; const defaults = userDataPaths();
  const [reviewer, governance] = await Promise.all([
    supportJournal(engine.reviewerRoot ?? roots.reviewerRoot ?? defaults.reviewerLedger, `${session.id}.review.journal.ndjson`),
    supportJournal(engine.governanceRoot ?? roots.governanceRoot ?? defaults.governanceLedger, `${session.id}.governance.journal.ndjson`),
  ]);
  return { reviewer: projectAuditJournal(reviewer), governance: projectAuditJournal(governance) };
}

function projectAuditJournal(journal) {
  return { records: journal.records.map((record) => ({ ...record, payload: supportDiagnosticSummary(record.payload) })),
    coverage: { ...journal.coverage, projection: 'typed_support_diagnostics', excluded: 'free_form_content' } };
}
