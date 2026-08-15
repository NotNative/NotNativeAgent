// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export class IdleArbiter {
  constructor(options) {
    if (!options || !Number.isSafeInteger(options.idleMs) || options.idleMs < 1
      || !Number.isSafeInteger(options.interStageMs) || options.interStageMs < 1
      || typeof options.eligible !== 'function' || typeof options.runStage !== 'function') {
      throw new ContractError('idle_arbiter_options_invalid', 'idle arbiter requires positive delays and eligible/runStage functions');
    }
    this.idleMs = options.idleMs;
    this.interStageMs = options.interStageMs;
    this.eligible = options.eligible;
    this.runStage = options.runStage;
    this.onState = options.onState ?? (() => undefined);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.timer = null;
    this.controller = null;
    this.started = false;
    this.paused = false;
    this.closed = false;
  }
  start() { if (!this.started && !this.closed) { this.started = true; this.#schedule(this.idleMs); } }
  activity(reason = 'activity') {
    if (this.closed) return;
    if (this.controller) this.controller.abort(reason);
    this.#clear();
    this.onState({ state: 'waiting', reason });
    if (this.started && !this.paused) this.#schedule(this.idleMs);
  }
  pause() {
    if (this.closed) return;
    this.paused = true;
    this.controller?.abort('paused');
    this.#clear();
    this.onState({ state: 'paused' });
  }
  resume() {
    if (this.closed) return;
    this.paused = false;
    this.started = true;
    this.onState({ state: 'waiting', reason: 'resumed' });
    if (!this.controller) this.#schedule(this.idleMs);
  }
  async runNow() { if (this.closed || this.paused || this.controller) return { state: 'skipped', reason: 'unavailable' }; return this.#run('manual'); }
  close() {
    this.closed = true;
    this.#clear();
    this.controller?.abort('closed');
    this.controller = null;
    this.onState({ state: 'closed' });
  }
  #schedule(delay) { this.#clear(); this.timer = this.setTimer(() => { this.timer = null; void this.#run('idle'); }, delay); }
  #clear() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
  async #run(trigger) {
    if (this.closed || this.paused || this.controller) return { state: 'skipped', reason: 'unavailable' };
    const controller = new AbortController(); this.controller = controller;
    try {
      if (!await this.eligible()) {
        this.onState({ state: 'waiting', reason: 'ineligible' });
        if (!this.closed && !this.paused) this.#schedule(this.idleMs);
        return { state: 'skipped', reason: 'ineligible' };
      }
      if (controller.signal.aborted) throw new ContractError('idle_stage_cancelled', 'idle stage was cancelled before execution');
      this.onState({ state: 'running', trigger });
      const result = await this.runStage({ trigger, signal: controller.signal });
      this.onState({ state: 'completed', trigger, result });
      if (!this.closed && !this.paused) this.#schedule(this.interStageMs);
      return { state: 'completed', result };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.onState({ state: cancelled ? 'cancelled' : 'failed', trigger, code: error?.code ?? null });
      if (!this.closed && !this.paused) this.#schedule(this.idleMs);
      return { state: cancelled ? 'cancelled' : 'failed', error };
    } finally { if (this.controller === controller) this.controller = null; }
  }
}
