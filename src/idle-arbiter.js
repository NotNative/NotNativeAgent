// SPDX-License-Identifier: Apache-2.0

export class IdleArbiter {
  constructor(options) {
    this.idleMs = options.idleMs;
    this.interStageMs = options.interStageMs;
    this.eligible = options.eligible;
    this.runStage = options.runStage;
    this.onState = options.onState ?? (() => undefined);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.timer = null; this.controller = null; this.started = false; this.paused = false; this.closed = false;
  }
  start() { if (!this.started && !this.closed) { this.started = true; this.#schedule(this.idleMs); } }
  activity(reason = 'activity') {
    if (this.closed) return;
    if (this.controller) this.controller.abort(reason);
    this.#clear();
    this.onState({ state: 'waiting', reason });
    if (this.started && !this.paused) this.#schedule(this.idleMs);
  }
  pause() { this.paused = true; this.activity('paused'); this.#clear(); this.onState({ state: 'paused' }); }
  resume() { if (this.closed) return; this.paused = false; this.started = true; this.activity('resumed'); }
  async runNow() { if (this.closed || this.paused || this.controller) return { state: 'skipped', reason: 'unavailable' }; return this.#run('manual'); }
  close() { this.closed = true; this.#clear(); this.controller?.abort('closed'); this.onState({ state: 'closed' }); }
  #schedule(delay) { this.#clear(); this.timer = this.setTimer(() => { this.timer = null; void this.#run('idle'); }, delay); }
  #clear() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
  async #run(trigger) {
    if (this.closed || this.paused || this.controller) return { state: 'skipped', reason: 'unavailable' };
    if (!await this.eligible()) { this.onState({ state: 'waiting', reason: 'ineligible' }); this.#schedule(this.idleMs); return { state: 'skipped', reason: 'ineligible' }; }
    const controller = new AbortController(); this.controller = controller;
    this.onState({ state: 'running', trigger });
    try {
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
