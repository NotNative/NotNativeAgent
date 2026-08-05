// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContractError, newId } from './ids.js';

const TERMINAL = new Set(['cancelled', 'completed', 'failed', 'skipped']);
const STATES = new Set(['queued', 'running', ...TERMINAL]);

export class DreamStore {
  constructor(options) {
    this.path = options.path;
    this.retentionDays = options.retentionDays ?? 30;
    this.db = null;
  }
  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    this.db.exec(SCHEMA);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE dream_runs SET state = 'cancelled', result_code = 'restart_recovered', finished_at = ? WHERE state IN ('queued','running')").run(now);
    this.cleanup();
    return this.status();
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
    this.db.prepare(`INSERT INTO dream_runs
      (id, runtime_key, stage, trigger, evidence_start, evidence_end, state, started_at,
       provider_fingerprint, input_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`)
      .run(id, input.runtimeKey, input.stage, input.trigger ?? 'idle', input.evidenceStart ?? null,
        input.evidenceEnd ?? null, now, input.providerFingerprint ?? null, input.inputFingerprint ?? null);
    return this.run(id);
  }
  finish(id, state, detail = {}) {
    this.#ready();
    if (!TERMINAL.has(state)) throw new ContractError('dream_state_invalid', 'dream run requires a terminal state');
    const current = this.run(id);
    if (!current) throw new ContractError('dream_run_missing', 'dream run does not exist');
    if (TERMINAL.has(current.state)) return current;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE dream_runs SET state=?, finished_at=?, result_code=?,
      duration_ms=?, input_tokens=?, output_tokens=?, output_fingerprint=? WHERE id=?`)
      .run(state, now, detail.resultCode ?? null, detail.durationMs ?? null,
        detail.inputTokens ?? null, detail.outputTokens ?? null, detail.outputFingerprint ?? null, id);
    return this.run(id);
  }
  run(id) { this.#ready(); return this.db.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) ?? null; }
  recent(limit = 50) {
    this.#ready();
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 50;
    return this.db.prepare('SELECT * FROM dream_runs ORDER BY rowid DESC LIMIT ?').all(bounded);
  }
  cleanup(now = Date.now()) {
    this.#ready();
    const cutoff = new Date(now - this.retentionDays * 86_400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM dream_runs WHERE finished_at < ? AND state IN ('cancelled','failed','skipped')").run(cutoff).changes);
  }
  status() {
    this.#ready();
    const counts = this.db.prepare('SELECT state, COUNT(*) AS count FROM dream_runs GROUP BY state').all();
    return { status: 'ready', path: this.path, runs: Object.fromEntries(counts.map((row) => [row.state, Number(row.count)])) };
  }
  close() { if (this.db) { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); this.db = null; } }
  #ready() { if (!this.db) throw new ContractError('dream_store_unavailable', 'dream state store is not initialized'); }
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
`;

export function validDreamState(value) { return STATES.has(value); }
