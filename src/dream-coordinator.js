// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { DreamStore } from './dream-store.js';
import { IdleArbiter } from './idle-arbiter.js';
import { userDataPaths } from './product.js';
import { diagnoseDreamEvidence } from './dream-diagnosis.js';

export class DreamCoordinator {
  constructor(options) {
    this.workspace = options.workspace;
    this.config = options.config;
    this.runtimeKey = workspaceKey(this.config.workspaceRoot);
    this.store = options.store ?? new DreamStore({
      path: options.path ?? userDataPaths().dreamState, retentionDays: this.config.dream.retentionDays,
    });
    this.state = { state: 'starting', reason: null, lastResult: null };
    this.arbiter = new IdleArbiter({
      idleMs: this.config.dream.idleMs, interStageMs: this.config.dream.interStageMs,
      eligible: () => this.#eligible(), runStage: (request) => this.#harvest(request),
      onState: (event) => { this.state = { ...this.state, ...event }; },
    });
  }
  async initialize() {
    await this.store.initialize();
    this.state = { state: this.config.dream.enabled ? 'waiting' : 'disabled', reason: null, lastResult: null };
    if (this.config.dream.enabled) this.arbiter.start();
    return this.status();
  }
  activity(reason) { if (this.config.dream.enabled) this.arbiter.activity(reason); }
  pause() { this.arbiter.pause(); }
  resume() { if (this.config.dream.enabled) this.arbiter.resume(); }
  runNow() { return this.arbiter.runNow(); }
  status() {
    return {
      enabled: this.config.dream.enabled, state: this.state.state, reason: this.state.reason,
      workspace: this.config.workspaceRoot, watermark: this.store.watermark(this.runtimeKey),
      store: this.store.status(), recent: this.store.recent(10),
    };
  }
  close() { this.arbiter.close(); this.store.close(); }
  async #eligible() {
    if (!this.config.dream.enabled || this.workspace.sessions.size === 0) return false;
    for (const session of this.workspace.sessions.values()) {
      if (session.engine.state.state !== 'idle') return false;
    }
    return (await this.#newEvidence()).length > 0;
  }
  async #harvest({ trigger, signal }) {
    const started = performance.now();
    const rows = await this.#newEvidence();
    if (signal.aborted) throw cancelled();
    if (rows.length === 0) return { code: 'no_new_evidence', records: 0 };
    const first = rows[0], last = rows.at(-1);
    const packet = evidencePacket(rows);
    const run = this.store.begin({
      runtimeKey: this.runtimeKey, stage: 0, trigger, evidenceStart: first.id, evidenceEnd: last.id,
      inputFingerprint: fingerprint(packet),
    });
    try {
      if (signal.aborted) throw cancelled();
      const result = { code: 'harvest_complete', records: rows.length, packet };
      this.store.finish(run.id, 'completed', {
        resultCode: result.code, durationMs: performance.now() - started,
        outputFingerprint: fingerprint(result),
      });
      this.store.commitWatermark({
        runtimeKey: this.runtimeKey, sessionId: last.session_id,
        turnSequence: last.id, stage: 0, configGeneration: this.config.version,
      });
      this.state.lastResult = result;
      return result;
    } catch (error) {
      this.store.finish(run.id, signal.aborted ? 'cancelled' : 'failed', {
        resultCode: signal.aborted ? 'activity_cancelled' : (error.code ?? 'harvest_failed'),
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }
  async #newEvidence() {
    const engine = this.workspace.sessions.values().next().value?.engine;
    if (!engine) return [];
    const watermark = this.store.watermark(this.runtimeKey)?.turn_sequence ?? 0;
    const rows = await engine.telemetry.query({ limit: 10_000 });
    return rows.filter((row) => row.id > watermark && row.turn_id && terminalEvidence(row));
  }
}

function terminalEvidence(row) {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'denied', 'skipped', 'unknown_effect'].includes(row.status);
}

function evidencePacket(rows) {
  const counts = {}, reasons = {}, turns = new Set(), sessions = new Set();
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    if (row.reason_code) reasons[row.reason_code] = (reasons[row.reason_code] ?? 0) + 1;
    if (row.turn_id) turns.add(row.turn_id);
    if (row.session_id) sessions.add(row.session_id);
  }
  return {
    records: rows.length, turns: turns.size, sessions: sessions.size, counts, reasons,
    diagnosis: diagnoseDreamEvidence(rows),
  };
}

function workspaceKey(root) { return createHash('sha256').update(root).digest('hex').slice(0, 32); }
function fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function cancelled() { return Object.assign(new Error('dream stage cancelled by foreground activity'), { code: 'dream_cancelled' }); }
