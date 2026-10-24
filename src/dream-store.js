// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContractError, newId } from './ids.js';
import { ProcessIdentity, validIdentity } from './reliability/process-identity.js';
import { migrateDreamRunOwner, recoverInterruptedDreamRuns, unverifiedActiveDreamRunCount } from './dream-run-ownership.js';

const TERMINAL = new Set(['cancelled', 'completed', 'failed', 'skipped']);
const STATES = new Set(['queued', 'running', ...TERMINAL]);
const CANDIDATE_STATES = new Set([
  'observed', 'gathering', 'ready', 'validating', 'proposed', 'active',
  'rejected', 'expired', 'regressed', 'rolled_back',
]);
const CANDIDATE_TRANSITIONS = Object.freeze({
  observed: new Set(['gathering', 'rejected', 'expired']),
  gathering: new Set(['ready', 'rejected', 'expired']),
  ready: new Set(['validating', 'rejected', 'expired']),
  validating: new Set(['proposed', 'gathering', 'rejected', 'expired']),
  proposed: new Set(['active', 'rejected', 'expired']),
  active: new Set(['regressed', 'expired']),
  rejected: new Set([]), expired: new Set([]),
  regressed: new Set(['rolled_back']), rolled_back: new Set([]),
});

export class DreamStore {
  constructor(options) {
    this.path = options.path;
    this.retentionDays = options.retentionDays ?? 30;
    if (!Number.isSafeInteger(this.retentionDays) || this.retentionDays < 1 || this.retentionDays > 365) {
      throw new ContractError('dream_retention_invalid', 'dream retention must be between one and 365 days');
    }
    this.observe = typeof options.observe === 'function' ? options.observe : null;
    this.db = null;
    this.pendingObservations = null;
    this.processIdentity = options.processIdentity ?? new ProcessIdentity();
    this.ownerIdentity = null;
    this.activeRunIds = new Set();
    this.initializing = null;
    this.closeRequested = false;
  }
  setObserver(observer) { this.observe = typeof observer === 'function' ? observer : null; }
  transaction(action) {
    this.#ready();
    if (typeof action !== 'function' || this.pendingObservations !== null) {
      throw new ContractError('dream_transaction_invalid', 'dream transaction requires one synchronous operation');
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.pendingObservations = [];
    try {
      const value = action();
      if (value && typeof value.then === 'function') {
        throw new ContractError('dream_transaction_invalid', 'dream transaction operation must be synchronous');
      }
      this.db.exec('COMMIT');
      const observations = this.pendingObservations;
      this.pendingObservations = null;
      for (const event of observations) this.#observed(event.phase, event.run);
      return value;
    } catch (error) {
      let rollbackFailure = null;
      try { this.db.exec('ROLLBACK'); } catch (failure) { rollbackFailure = failure; }
      this.pendingObservations = null;
      if (rollbackFailure) throw new AggregateError([error, rollbackFailure], 'dream transaction and rollback failed');
      throw error;
    }
  }
  initialize() {
    if (this.initializing) return this.initializing;
    if (this.db) return Promise.resolve(this.status());
    this.closeRequested = false;
    this.initializing = this.#open().then((status) => {
      if (this.closeRequested) throw new ContractError('dream_store_unavailable', 'dream store closed during initialization');
      return status;
    }).finally(() => {
      this.initializing = null;
      if (this.closeRequested && this.db) this.close();
    });
    return this.initializing;
  }
  async #open() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.#assertNotClosing();
    // This local maintenance store intentionally uses synchronous SQLite.
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
      this.db.exec(SCHEMA);
      migrateDreamRunOwner(this.db);
      this.ownerIdentity = await this.processIdentity.capture(process.pid);
      this.#assertNotClosing();
      if (!validIdentity(this.ownerIdentity) || !this.ownerIdentity.start_id) {
        throw new ContractError('dream_store_unavailable', 'dream process identity is unavailable');
      }
      await recoverInterruptedDreamRuns(this.db, this.processIdentity, () => this.#assertNotClosing());
      this.#assertNotClosing();
      this.#quarantineMalformedRows();
      this.cleanup();
      return this.status();
    } catch (error) {
      this.db?.close();
      this.db = null;
      this.ownerIdentity = null;
      throw error;
    }
  }
  watermark(runtimeKey) {
    this.#ready();
    return this.db.prepare('SELECT * FROM dream_watermarks WHERE runtime_key = ?').get(runtimeKey) ?? null;
  }
  commitWatermark(input) {
    this.#ready();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO dream_watermarks
      (runtime_key, session_id, turn_sequence, stage, config_generation, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(runtime_key) DO UPDATE SET session_id=excluded.session_id,
      turn_sequence=excluded.turn_sequence, stage=excluded.stage,
      config_generation=excluded.config_generation, updated_at=excluded.updated_at`)
      .run(input.runtimeKey, input.sessionId ?? null, input.turnSequence ?? 0,
        input.stage ?? 0, input.configGeneration ?? null, now);
    return this.watermark(input.runtimeKey);
  }
  begin(input) {
    this.#ready();
    const id = input.id ?? newId('dream_run');
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO dream_runs
        (id, runtime_key, stage, trigger, evidence_start, evidence_end, state, started_at,
         provider_fingerprint, input_fingerprint, owner_identity)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(id, input.runtimeKey, input.stage, input.trigger ?? 'idle', input.evidenceStart ?? null,
          input.evidenceEnd ?? null, now, input.providerFingerprint ?? null, input.inputFingerprint ?? null,
          JSON.stringify(this.ownerIdentity));
    } catch (error) {
      if (String(error?.message).includes('idx_dream_runs_active')
          || String(error?.message).includes('UNIQUE constraint failed: dream_runs.runtime_key')) {
        throw new ContractError('dream_run_active', 'another process already owns idle maintenance for this workspace');
      }
      throw error;
    }
    const run = this.run(id);
    this.activeRunIds.add(id);
    this.#observed('started', run);
    return run;
  }
  finish(id, state, detail = {}) {
    this.#ready();
    if (!TERMINAL.has(state)) throw new ContractError('dream_state_invalid', 'dream run requires a terminal state');
    const current = this.run(id);
    if (!current) throw new ContractError('dream_run_missing', 'dream run does not exist');
    if (TERMINAL.has(current.state)) { this.activeRunIds.delete(id); return current; }
    const now = new Date().toISOString();
    const update = this.db.prepare(`UPDATE dream_runs SET state=?, finished_at=?, result_code=?,
      duration_ms=?, input_tokens=?, output_tokens=?, output_fingerprint=? WHERE id=? AND state=?`)
      .run(state, now, detail.resultCode ?? null, detail.durationMs ?? null,
        detail.inputTokens ?? null, detail.outputTokens ?? null, detail.outputFingerprint ?? null, id, current.state);
    if (update.changes === 0) {
      const winner = this.run(id);
      if (!winner) throw new ContractError('dream_run_missing', 'dream run does not exist');
      if (TERMINAL.has(winner.state)) { this.activeRunIds.delete(id); return winner; }
      throw new ContractError('dream_state_invalid', 'dream run changed during completion');
    }
    const finished = this.run(id);
    this.activeRunIds.delete(id);
    this.#observed('finished', finished);
    return finished;
  }
  run(id) { this.#ready(); return this.db.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) ?? null; }
  recent(limit = 50) {
    this.#ready();
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 50;
    return this.db.prepare('SELECT * FROM dream_runs ORDER BY rowid DESC LIMIT ?').all(bounded);
  }
  savePacket(input) {
    this.#ready();
    const id = boundedId(input.id ?? newId('dream_packet'), 'packet id');
    const runtimeKey = boundedId(input.runtimeKey, 'runtime key');
    const evidenceId = boundedId(input.evidenceId, 'governance evidence id');
    const payload = boundedPacket(input.payload);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO dream_packets
      (id, runtime_key, stage, state, evidence_start, evidence_end, governance_evidence_id,
       payload, payload_fingerprint, created_at, updated_at)
      VALUES (?, ?, 1, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, runtimeKey, input.evidenceStart ?? null, input.evidenceEnd ?? null,
        evidenceId, JSON.stringify(payload), digest(JSON.stringify(payload)), now, now);
    return this.packet(id);
  }
  pendingPacket(runtimeKey) {
    this.#ready();
    const row = this.db.prepare("SELECT * FROM dream_packets WHERE runtime_key = ? AND state = 'pending' ORDER BY rowid LIMIT 1")
      .get(runtimeKey);
    return row ? this.#packetValue(row) : null;
  }
  finishPacket(id, resultCode) {
    this.#ready();
    const packet = this.packet(id);
    if (!packet) throw new ContractError('dream_packet_missing', 'dream evidence packet does not exist');
    if (packet.state !== 'pending') return packet;
    this.db.prepare("UPDATE dream_packets SET state='completed', result_code=?, updated_at=? WHERE id=?")
      .run(boundedId(resultCode, 'packet result code'), new Date().toISOString(), id);
    return this.packet(id);
  }
  advancePacket(id, stage, resultCode) {
    this.#ready();
    const packet = this.packet(id);
    if (!packet || packet.state !== 'pending' || !Number.isSafeInteger(stage)
        || stage !== packet.stage + 1 || stage > 8) {
      throw new ContractError('dream_packet_transition_invalid', 'dream evidence packet stage transition is invalid');
    }
    this.db.prepare('UPDATE dream_packets SET stage=?, result_code=?, updated_at=? WHERE id=?')
      .run(stage, boundedId(resultCode, 'packet result code'), new Date().toISOString(), id);
    return this.packet(id);
  }
  packet(id) {
    this.#ready();
    const row = this.db.prepare('SELECT * FROM dream_packets WHERE id = ?').get(id);
    return row ? this.#packetValue(row) : null;
  }
  observeCandidate(input) {
    this.#ready();
    const candidate = normalizeCandidate(input);
    const existing = this.candidate(candidate.id);
    if (existing) {
      if (existing.payload_fingerprint !== candidate.payloadFingerprint
          || existing.kind !== candidate.kind || existing.scope_fingerprint !== candidate.scopeFingerprint) {
        throw new ContractError('dream_candidate_drift', 'candidate identity was reused with different content');
      }
      // Replaying the same evidence after a stage checkpoint failure is not a new recurrence.
      const priorRefs = new Set(existing.evidence_refs);
      const newEvidence = candidate.evidenceRefs.some((ref) => !priorRefs.has(ref));
      this.db.prepare(`UPDATE improvement_candidates SET recurrence_count=recurrence_count+?,
        confidence=?, evidence_refs=?, updated_at=? WHERE id=?`)
        .run(newEvidence ? 1 : 0, Math.max(Number(existing.confidence), candidate.confidence),
          JSON.stringify([...new Set([...existing.evidence_refs, ...candidate.evidenceRefs])].slice(-64)),
          new Date().toISOString(), candidate.id);
      return this.candidate(candidate.id);
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO improvement_candidates
      (id, runtime_key, kind, scope_kind, scope_fingerprint, state, confidence,
       recurrence_count, evidence_refs, expected_benefit, success_criteria, risk_class,
       expires_at, payload, payload_fingerprint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(candidate.id, candidate.runtimeKey, candidate.kind, candidate.scopeKind,
        candidate.scopeFingerprint, candidate.confidence, candidate.recurrenceCount,
        JSON.stringify(candidate.evidenceRefs), candidate.expectedBenefit,
        JSON.stringify(candidate.successCriteria), candidate.riskClass, candidate.expiresAt,
        JSON.stringify(candidate.payload), candidate.payloadFingerprint, now, now);
    return this.candidate(candidate.id);
  }
  transitionCandidate(id, state, detail = {}) {
    this.#ready();
    if (!CANDIDATE_STATES.has(state)) throw new ContractError('dream_candidate_state_invalid', 'candidate state is invalid');
    const current = this.candidate(id);
    if (!current) throw new ContractError('dream_candidate_missing', 'candidate does not exist');
    if (!CANDIDATE_TRANSITIONS[current.state]?.has(state)) {
      throw new ContractError('dream_candidate_transition_invalid', `candidate cannot transition from ${current.state} to ${state}`);
    }
    const rejectionReason = state === 'rejected' ? boundedText(detail.reason, 512, 'rejection reason') : null;
    const supersededBy = detail.supersededBy === undefined ? null : boundedId(detail.supersededBy, 'superseding candidate');
    this.db.prepare(`UPDATE improvement_candidates SET state=?, rejection_reason=?,
      superseded_by=?, updated_at=? WHERE id=?`)
      .run(state, rejectionReason, supersededBy, new Date().toISOString(), id);
    return this.candidate(id);
  }
  candidate(id) {
    this.#ready();
    const row = this.db.prepare('SELECT * FROM improvement_candidates WHERE id = ?').get(id);
    return row ? this.#candidateValue(row) : null;
  }
  candidates(input = {}) {
    this.#ready();
    const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(500, input.limit)) : 50;
    if (input.state !== undefined) {
      if (!CANDIDATE_STATES.has(input.state)) throw new ContractError('dream_candidate_state_invalid', 'candidate state is invalid');
      return this.db.prepare('SELECT * FROM improvement_candidates WHERE state = ? ORDER BY updated_at DESC LIMIT ?')
        .all(input.state, limit).map((row) => this.#candidateValue(row)).filter(Boolean);
    }
    return this.db.prepare('SELECT * FROM improvement_candidates ORDER BY updated_at DESC LIMIT ?')
      .all(limit).map((row) => this.#candidateValue(row)).filter(Boolean);
  }
  cleanup(now = Date.now()) {
    this.#ready();
    const cutoff = new Date(now - this.retentionDays * 86_400_000).toISOString();
    const runs = Number(this.db.prepare("DELETE FROM dream_runs WHERE finished_at < ? AND state IN ('cancelled','completed','failed','skipped')").run(cutoff).changes);
    const packets = Number(this.db.prepare("DELETE FROM dream_packets WHERE updated_at < ? AND state = 'completed'").run(cutoff).changes);
    return runs + packets;
  }
  status() {
    this.#ready();
    const counts = this.db.prepare('SELECT state, COUNT(*) AS count FROM dream_runs GROUP BY state').all();
    const candidates = this.db.prepare('SELECT state, COUNT(*) AS count FROM improvement_candidates GROUP BY state').all();
    return {
      status: 'ready', path: this.path,
      unverified_active_runs: unverifiedActiveDreamRunCount(this.db),
      runs: Object.fromEntries(counts.map((row) => [row.state, Number(row.count)])),
      candidates: Object.fromEntries(candidates.map((row) => [row.state, Number(row.count)])),
    };
  }
  close() {
    if (this.initializing) { this.closeRequested = true; return; }
    if (!this.db) return;
    try {
      for (const id of this.activeRunIds) {
        this.db.prepare("UPDATE dream_runs SET state='cancelled', result_code='store_closed', finished_at=? WHERE id=? AND state IN ('queued','running') AND owner_identity=?")
          .run(new Date().toISOString(), id, JSON.stringify(this.ownerIdentity));
      }
    } finally {
      this.activeRunIds.clear();
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      finally { this.db.close(); this.db = null; this.ownerIdentity = null; }
    }
  }
  #observed(phase, run) {
    if (this.pendingObservations !== null) { this.pendingObservations.push({ phase, run }); return; }
    try { this.observe?.(Object.freeze({ phase, run: Object.freeze({ ...run }) })); }
    catch { /* maintenance observability cannot break maintenance durability */ }
  }
  #packetValue(row) {
    const packet = parsePacket(row);
    if (packet) return packet;
    this.db.prepare("UPDATE dream_packets SET state='completed', result_code='malformed_payload_quarantined', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), row.id);
    return null;
  }
  #candidateValue(row) {
    const candidate = parseCandidate(row);
    if (candidate) return candidate;
    this.db.prepare("UPDATE improvement_candidates SET state='rejected', rejection_reason='malformed_durable_payload', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), row.id);
    return null;
  }
  #quarantineMalformedRows() {
    for (const row of this.db.prepare("SELECT * FROM dream_packets WHERE state='pending'").all()) this.#packetValue(row);
    for (const row of this.db.prepare('SELECT * FROM improvement_candidates').all()) this.#candidateValue(row);
  }
  #ready() { if (!this.db || !this.ownerIdentity) throw new ContractError('dream_store_unavailable', 'dream state store is not initialized'); }
  #assertNotClosing() {
    if (this.closeRequested) throw new ContractError('dream_store_unavailable', 'dream store closed during initialization');
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dream_watermarks (
  runtime_key TEXT PRIMARY KEY, session_id TEXT, turn_sequence INTEGER NOT NULL DEFAULT 0,
  stage INTEGER NOT NULL DEFAULT 0, config_generation TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dream_runs (
  id TEXT PRIMARY KEY, runtime_key TEXT NOT NULL, stage INTEGER NOT NULL, trigger TEXT NOT NULL,
  evidence_start INTEGER, evidence_end INTEGER, state TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, provider_fingerprint TEXT, input_fingerprint TEXT, output_fingerprint TEXT,
  result_code TEXT, duration_ms REAL, input_tokens INTEGER, output_tokens INTEGER,
  CHECK(state IN ('queued','running','cancelled','completed','failed','skipped'))
);
CREATE INDEX IF NOT EXISTS idx_dream_runs_runtime ON dream_runs(runtime_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dream_runs_state ON dream_runs(state, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_runs_active ON dream_runs(runtime_key) WHERE state = 'running';
CREATE TABLE IF NOT EXISTS dream_packets (
  id TEXT PRIMARY KEY, runtime_key TEXT NOT NULL, stage INTEGER NOT NULL,
  state TEXT NOT NULL, evidence_start INTEGER, evidence_end INTEGER,
  governance_evidence_id TEXT NOT NULL, payload TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL, result_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(state IN ('pending','completed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_packets_pending ON dream_packets(runtime_key) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS improvement_candidates (
  id TEXT PRIMARY KEY, runtime_key TEXT NOT NULL, kind TEXT NOT NULL,
  scope_kind TEXT NOT NULL, scope_fingerprint TEXT NOT NULL, state TEXT NOT NULL,
  confidence REAL NOT NULL, recurrence_count INTEGER NOT NULL,
  evidence_refs TEXT NOT NULL, expected_benefit TEXT NOT NULL,
  success_criteria TEXT NOT NULL, risk_class TEXT NOT NULL, expires_at TEXT,
  superseded_by TEXT, rejection_reason TEXT, payload TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(state IN ('observed','gathering','ready','validating','proposed','active','rejected','expired','regressed','rolled_back'))
);
CREATE INDEX IF NOT EXISTS idx_improvement_candidates_runtime ON improvement_candidates(runtime_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_improvement_candidates_state ON improvement_candidates(state, updated_at DESC);
`;

export function validDreamState(value) { return STATES.has(value); }

function normalizeCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContractError('dream_candidate_invalid', 'candidate must be an object');
  const payload = boundedPayload(input.payload ?? {});
  return {
    id: boundedId(input.id ?? newId('improvement'), 'candidate id'),
    runtimeKey: boundedId(input.runtimeKey, 'runtime key'),
    kind: boundedId(input.kind, 'candidate kind'),
    scopeKind: boundedId(input.scope?.kind, 'scope kind'),
    scopeFingerprint: boundedDigest(input.scope?.fingerprint),
    confidence: boundedNumber(input.confidence ?? 0),
    recurrenceCount: boundedInteger(input.recurrenceCount ?? 1),
    evidenceRefs: boundedRefs(input.evidenceRefs ?? []),
    expectedBenefit: boundedText(input.expectedBenefit, 1024, 'expected benefit'),
    successCriteria: boundedList(input.successCriteria, 16, 512, 'success criteria'),
    riskClass: boundedId(input.riskClass ?? 'low', 'risk class'),
    expiresAt: input.expiresAt === undefined || input.expiresAt === null ? null : validDate(input.expiresAt),
    payload,
    payloadFingerprint: digest(JSON.stringify(payload)),
  };
}

function parseCandidate(row) {
  const evidenceRefs = storedArray(row.evidence_refs, 64);
  const successCriteria = storedArray(row.success_criteria, 16);
  const payload = storedObject(row.payload, 16_384);
  if (!evidenceRefs || !successCriteria || !payload || digest(JSON.stringify(payload)) !== row.payload_fingerprint) return null;
  return Object.freeze({
    ...row, confidence: Number(row.confidence), recurrence_count: Number(row.recurrence_count),
    evidence_refs: Object.freeze(evidenceRefs), success_criteria: Object.freeze(successCriteria),
    payload: Object.freeze(payload),
  });
}

function parsePacket(row) {
  const payload = storedObject(row.payload, 32_768);
  if (!payload || digest(JSON.stringify(payload)) !== row.payload_fingerprint) return null;
  return Object.freeze({ ...row, stage: Number(row.stage), payload: Object.freeze(payload) });
}

function storedArray(text, maximum) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === 'string') ? value : null;
  } catch { return null; }
}

function storedObject(text, maximumBytes) {
  // Stored JSON is size-bounded and shape-checked.
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maximumBytes) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function boundedPacket(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('dream_packet_invalid', 'dream packet must be an object');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > 32_768) throw new ContractError('dream_packet_invalid', 'dream packet exceeds 32 KiB');
  return structuredClone(value);
}

function boundedPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('dream_candidate_payload_invalid', 'candidate payload must be an object');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > 16_384) throw new ContractError('dream_candidate_payload_invalid', 'candidate payload exceeds 16 KiB');
  if (hasSecretField(value)) throw new ContractError('dream_candidate_secret_forbidden', 'candidate payload may not contain secret-bearing fields');
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*/u.test(encoded)) {
    throw new ContractError('dream_candidate_secret_forbidden', 'candidate payload appears to contain secret material');
  }
  return structuredClone(value);
}

function hasSecretField(value) {
  const forbidden = /(?:secret|password|passwd|token|credential|api[_-]?key|authorization)/iu;
  if (Array.isArray(value)) return value.some(hasSecretField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => forbidden.test(key) || hasSecretField(child));
}

function boundedRefs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new ContractError('dream_candidate_evidence_invalid', 'candidate requires 1 to 64 evidence references');
  return [...new Set(value.map((item) => boundedId(item, 'evidence reference')))];
}
function boundedList(value, maxItems, maxBytes, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) throw new ContractError('dream_candidate_invalid', `${label} is invalid`);
  return value.map((item) => boundedText(item, maxBytes, label));
}
function boundedText(value, maximum, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > maximum) throw new ContractError('dream_candidate_invalid', `${label} must be bounded text`);
  return value.trim();
}
function boundedId(value, label) {
  const text = boundedText(value, 160, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/u.test(text)) throw new ContractError('dream_candidate_invalid', `${label} has an invalid format`);
  return text;
}
function boundedDigest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new ContractError('dream_candidate_invalid', 'scope fingerprint must be sha256');
  return value;
}
function boundedNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new ContractError('dream_candidate_invalid', 'confidence must be between 0 and 1');
  return value;
}
function boundedInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new ContractError('dream_candidate_invalid', 'recurrence count is invalid');
  return value;
}
function validDate(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new ContractError('dream_candidate_invalid', 'candidate expiry is invalid');
  return new Date(value).toISOString();
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
