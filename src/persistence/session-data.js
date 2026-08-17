// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError, requireExternalId } from '../ids.js';
import { inspectSessionLock, preserveStaleSessionLock } from './session-lock.js';
import { inspectJournalRepairPrefix, recoverJournal, restoreJournalFromVerifiedPrefix, rewriteJournal } from '../store.js';
import { StructuredLog } from '../structured-log.js';

const MAX_LISTED_SESSIONS = 10_000;

export class SessionDataManager {
  constructor(options) {
    this.sessionRoot = options.sessionRoot;
    this.reviewerRoot = options.reviewerRoot;
    this.diagnosticsRoot = options.diagnosticsRoot ?? null;
    this.processIdentity = options.processIdentity;
  }

  async preview(sessionId) {
    requireExternalId(sessionId, 'session_id');
    const paths = await candidatePaths(this, sessionId);
    const categories = [];
    for (const item of paths) {
      const { category, path } = item;
      const details = path ? await safeStat(path) : null;
      categories.push({ category, path, exists: details !== null, bytes: details?.size ?? null,
        disposition: item.disposition ?? null, deletable: item.deletable !== false });
    }
    const health = await this.#inspect(sessionId);
    return Object.freeze({ session_id: sessionId, display_id: health.display_id, health,
      categories, cloud_provider_data: 'outside_nna_control' });
  }

  async list() {
    const ids = await discoverSessionIds(this.sessionRoot, this.reviewerRoot);
    const sessions = [];
    for (const id of ids) sessions.push(await this.#inspect(id));
    sessions.sort((left, right) => statusRank(left.status) - statusRank(right.status)
      || right.updated_at.localeCompare(left.updated_at) || left.session_id.localeCompare(right.session_id));
    return Object.freeze({
      sessions: Object.freeze(sessions),
      counts: Object.freeze({
        total: sessions.length,
        repairable: sessions.filter((item) => item.status === 'repair_required').length,
        active: sessions.filter((item) => item.status === 'active').length,
        inspection_required: sessions.filter((item) => item.status === 'inspection_required').length,
        healthy: sessions.filter((item) => item.status === 'healthy').length,
      }),
    });
  }

  async repairAll() {
    const listing = await this.list();
    const repaired = [];
    const skipped = [];
    for (const session of listing.sessions) {
      if (session.status !== 'repair_required') {
        if (session.status !== 'healthy') skipped.push(Object.freeze({
          session_id: session.session_id, status: session.status, reasons: session.reasons,
        }));
        continue;
      }
      try {
        const result = await this.repair(session.session_id, `repair:${session.session_id}`);
        repaired.push(result);
      } catch (error) {
        skipped.push(Object.freeze({ session_id: session.session_id,
          status: 'changed_during_repair', code: error.code ?? 'repair_failed' }));
      }
    }
    return Object.freeze({ mode: 'deterministic_bulk_repair', repaired: Object.freeze(repaired),
      skipped: Object.freeze(skipped), healthy_unchanged: listing.counts.healthy });
  }

  async exportRedacted(sessionId, path) {
    const preview = await this.preview(sessionId);
    const paths = await candidatePaths(this, sessionId);
    const transcript = paths.find((item) => item.category === 'transcript')?.path;
    const reviewer = paths.find((item) => item.category === 'reviewer_ledger')?.path;
    const records = await redactedRecords(transcript);
    const reviewerRecords = await redactedRecords(reviewer);
    const bundle = {
      format: 1, created_at: new Date().toISOString(), preview, redacted: true,
      records, reviewer_records: reviewerRecords,
    };
    await writeExclusive(path, JSON.stringify(bundle, null, 2));
    return Object.freeze({ path, records: records.length, redacted: true });
  }

  async deleteToTrash(sessionId, confirmation) {
    if (confirmation !== `delete:${sessionId}`) {
      throw new ContractError('deletion_confirmation_required', 'exact session deletion confirmation is required');
    }
    const preview = await this.preview(sessionId);
    const lock = preview.categories.find((item) => item.category === 'lock');
    if (lock?.exists) throw new ContractError('session_locked', 'an attached or stale session lock requires inspection before deletion');
    const trash = join(this.sessionRoot, '.trash', `${sessionId}.${Date.now()}.${randomUUID()}`);
    await mkdir(trash, { recursive: true, mode: 0o700 });
    const moved = [];
    const incomplete = [];
    for (const item of preview.categories.filter((entry) => entry.exists && entry.category !== 'lock' && entry.deletable)) {
      try {
        const safeCategory = item.category.replaceAll(/[^A-Za-z0-9_.-]/gu, '_');
        const target = join(trash, `${safeCategory}-${basename(item.path)}`);
        await rename(item.path, target); moved.push({ category: item.category, target });
      } catch (error) { incomplete.push({ category: item.category, code: error.code ?? 'move_failed' }); }
    }
    for (const item of preview.categories.filter((entry) => entry.exists && !entry.deletable)) {
      incomplete.push({ category: item.category, code: item.disposition ?? 'shared_data_retained' });
    }
    return Object.freeze({ session_id: sessionId, recoverable_trash: trash, moved, incomplete });
  }

  async repair(sessionId, confirmation) {
    requireExternalId(sessionId, 'session_id');
    if (confirmation !== `repair:${sessionId}`) {
      throw new ContractError('repair_confirmation_required', 'exact session repair confirmation is required');
    }
    const actions = [];
    const lockPath = join(this.sessionRoot, `${sessionId}.lock`);
    const lockInspection = await inspectSessionLock(lockPath, { processIdentity: this.processIdentity });
    if (['live', 'unknown'].includes(lockInspection.status)) {
      throw new ContractError('session_locked', 'session lock still belongs to a live or unverifiable process');
    }
    const journalPath = join(this.sessionRoot, `${sessionId}.journal.ndjson`);
    const recovered = await recoverJournal(journalPath, { tailLimit: 10_000 });
    const prefix = recovered.corruptTail
      ? await latestVerifiedPrefix(this.sessionRoot, `${sessionId}.journal.ndjson`) : null;
    if (recovered.corruptTail && !prefix) {
      throw new ContractError('journal_repair_evidence_missing', 'corrupt journal has no preserved verified prefix');
    }
    if (prefix) await inspectJournalRepairPrefix(prefix);
    const lock = await preserveStaleSessionLock(lockPath, { processIdentity: this.processIdentity });
    if (lock.repaired) actions.push(Object.freeze({ type: 'stale_lock_preserved', status: lock.status, evidence_path: lock.evidence_path }));
    if (recovered.corruptTail) {
      const restored = await restoreJournalFromVerifiedPrefix(journalPath, prefix);
      actions.push(Object.freeze({ type: 'journal_prefix_restored', records: restored.records,
        evidence_path: restored.evidence_path, prefix_path: restored.prefix_path }));
    }
    await this.#recordRepair(sessionId, actions);
    return Object.freeze({ session_id: sessionId, repaired: actions.length > 0, actions: Object.freeze(actions) });
  }

  async compact(sessionId, confirmation) {
    requireExternalId(sessionId, 'session_id');
    if (confirmation !== `compact:${sessionId}`) {
      throw new ContractError('compaction_confirmation_required', 'exact session compaction confirmation is required');
    }
    const lock = await safeStat(join(this.sessionRoot, `${sessionId}.lock`));
    if (lock) throw new ContractError('session_locked', 'session must be detached and repaired before journal compaction');
    const path = join(this.sessionRoot, `${sessionId}.journal.ndjson`);
    const before = await safeStat(path);
    if (!before) throw new ContractError('session_missing', 'session journal does not exist');
    const recovered = await recoverJournal(path);
    if (recovered.corruptTail) throw new ContractError('journal_corrupt', 'repair the corrupt journal before compaction');
    const plan = physicalCompactionPlan(recovered.records);
    await rewriteJournal(path, plan.records);
    const after = await safeStat(path);
    await this.#recordRepair(sessionId, [{ type: 'journal_compacted' }]);
    return Object.freeze({
      session_id: sessionId, before_bytes: before.size, after_bytes: after.size,
      removed_records: recovered.records.length - plan.records.length,
      retained_records: plan.records.length, boundary_sequence: plan.boundarySequence,
    });
  }

  async #inspect(sessionId) {
    requireExternalId(sessionId, 'session_id');
    const journalPath = join(this.sessionRoot, `${sessionId}.journal.ndjson`);
    const lockPath = join(this.sessionRoot, `${sessionId}.lock`);
    const [journalDetails, lockDetails, reviewerDetails] = await Promise.all([
      safeStat(journalPath), safeStat(lockPath), safeStat(join(this.reviewerRoot, `${sessionId}.review.journal.ndjson`)),
    ]);
    const lock = await inspectSessionLock(lockPath, { processIdentity: this.processIdentity });
    const reasons = [];
    let repairable = false;
    let blocked = false;
    if (lock.status === 'live') reasons.push('active_lock');
    else if (lock.status === 'unknown') { reasons.push('lock_owner_unverifiable'); blocked = true; }
    else if (lock.status !== 'missing') { reasons.push(`stale_lock:${lock.status}`); repairable = true; }

    if (journalDetails) {
      try {
        const journal = await recoverJournal(journalPath);
        if (journal.corruptTail) {
          const prefix = await latestVerifiedPrefix(this.sessionRoot, `${sessionId}.journal.ndjson`);
          if (!prefix) { reasons.push('corrupt_journal_without_verified_prefix'); blocked = true; }
          else {
            try { await inspectJournalRepairPrefix(prefix); reasons.push('corrupt_journal_with_verified_prefix'); repairable = true; }
            catch { reasons.push('corrupt_journal_with_invalid_verified_prefix'); blocked = true; }
          }
        }
      } catch (error) {
        reasons.push(error.code ?? 'journal_inspection_failed');
        blocked = true;
      }
    }

    let status = 'healthy';
    if (lock.status === 'live') status = 'active';
    else if (blocked) status = 'inspection_required';
    else if (repairable) status = 'repair_required';
    const marker = status === 'repair_required' ? ' [REPAIR REQUIRED]'
      : status === 'inspection_required' ? ' [INSPECTION REQUIRED]'
        : status === 'active' ? ' [ACTIVE]' : '';
    const updated = Math.max(journalDetails?.mtimeMs ?? 0, lockDetails?.mtimeMs ?? 0, reviewerDetails?.mtimeMs ?? 0);
    return Object.freeze({
      session_id: sessionId, display_id: `${sessionId}${marker}`, status,
      reasons: Object.freeze(reasons), updated_at: updated ? new Date(updated).toISOString() : new Date(0).toISOString(),
      repair_command: status === 'repair_required' ? `nna sessions repair ${sessionId} repair:${sessionId}` : null,
    });
  }

  async #recordRepair(sessionId, actions) {
    if (!this.diagnosticsRoot) return;
    const log = await new StructuredLog({ path: join(this.diagnosticsRoot, 'repair.ndjson') }).initialize();
    log.record({ type: 'session_repair', operation: actions.map((item) => item.type).join(',') || 'none',
      outcome: actions.length > 0 ? 'completed' : 'unchanged', session_id: sessionId });
    await log.flush();
  }
}

async function discoverSessionIds(sessionRoot, reviewerRoot) {
  const ids = new Set();
  const sessionNames = await readdir(sessionRoot).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const reviewerNames = await readdir(reviewerRoot).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of sessionNames) {
    if (name.endsWith('.journal.ndjson')) ids.add(name.slice(0, -'.journal.ndjson'.length));
    else if (name.endsWith('.lock')) ids.add(name.slice(0, -'.lock'.length));
  }
  for (const name of reviewerNames) {
    if (name.endsWith('.review.journal.ndjson')) ids.add(name.slice(0, -'.review.journal.ndjson'.length));
  }
  if (ids.size > MAX_LISTED_SESSIONS) {
    throw new ContractError('session_list_too_large', `session list exceeds the ${MAX_LISTED_SESSIONS} entry bound`);
  }
  return [...ids].filter((id) => {
    try { requireExternalId(id, 'session_id'); return true; } catch { return false; }
  });
}

function statusRank(status) {
  return { repair_required: 0, inspection_required: 1, active: 2, healthy: 3 }[status] ?? 4;
}

async function latestVerifiedPrefix(root, base) {
  let names;
  try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const prefix = `${base}.verified-prefix.`;
  const candidates = names.filter((name) => name.startsWith(prefix)).sort().reverse();
  return candidates[0] ? join(root, candidates[0]) : null;
}

function physicalCompactionPlan(records) {
  let boundary = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].type === 'compaction_snapshot') { boundary = index; break; }
  }
  if (boundary < 0) throw new ContractError('journal_compaction_snapshot_missing', 'journal has no durable compaction snapshot');
  const superseded = new Set(['message', 'tool_request', 'tool_result', 'compaction', 'compaction_snapshot']);
  const recordsBefore = records.slice(0, boundary).filter((record) => !superseded.has(record.type));
  return Object.freeze({ records: Object.freeze([...recordsBefore, ...records.slice(boundary)]), boundarySequence: records[boundary].sequence });
}

async function candidatePaths(manager, id) {
  const transcriptName = `${id}.journal.ndjson`;
  const reviewerName = `${id}.review.journal.ndjson`;
  const result = [
    { category: 'transcript', path: join(manager.sessionRoot, transcriptName) },
    { category: 'lock', path: join(manager.sessionRoot, `${id}.lock`) },
    { category: 'attachments', path: join(manager.sessionRoot, 'attachments', id) },
    { category: 'reviewer_ledger', path: join(manager.reviewerRoot, reviewerName) },
  ];
  result.push(...await derivedPaths(manager.sessionRoot, transcriptName, 'transcript_derived'));
  result.push(...await derivedPaths(manager.reviewerRoot, reviewerName, 'reviewer_derived'));
  result.push({
    category: 'diagnostics', path: manager.diagnosticsRoot,
    disposition: manager.diagnosticsRoot ? 'shared_metadata_retained' : 'not_configured', deletable: false,
  });
  result.push({ category: 'derived_indexes_and_caches', path: null, disposition: 'none_materialized_by_core', deletable: false });
  result.push({ category: 'memory', path: null, disposition: 'external_adapter_lifecycle', deletable: false });
  return result;
}

async function derivedPaths(root, base, category) {
  let names;
  try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name.startsWith(`${base}.`) && name !== `${base}.lock`)
    .map((name) => ({ category: `${category}:${name.slice(base.length + 1)}`, path: join(root, name) }));
}

async function safeStat(path) {
  try { return await stat(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readBounded(path, limit) {
  const details = await stat(path);
  if (details.size > limit) throw new ContractError('export_too_large', 'session export exceeds bound');
  return readFile(path, 'utf8');
}

async function redactedRecords(path) {
  if (!path) return [];
  let journal;
  try { journal = await readBounded(path, 104_857_600); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return journal.split(/\r?\n/u).filter(Boolean).slice(0, 1_000_000).map(redactLine);
}

function redactLine(line) {
  let record;
  try { record = JSON.parse(line); } catch { return { omitted: true, reason: 'malformed_record' }; }
  return redactSecrets(redactContent(record));
}

function redactContent(value, key = '') {
  if (/^(?:content|text|summary|prompt)$/iu.test(key)) return '[redacted content]';
  if (Array.isArray(value)) return value.map((item) => redactContent(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactContent(item, name)]));
  }
  return value;
}

function redactSecrets(value) {
  const encoded = JSON.stringify(value);
  return JSON.parse(encoded.replaceAll(
    /(?:bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[=:]\s*[^"\s]+)/giu,
    '[redacted secret]',
  ));
}

async function writeExclusive(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
}
