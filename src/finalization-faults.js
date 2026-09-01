// SPDX-License-Identifier: Apache-2.0
import { failureEnvelope } from './failure-envelope.js';

const TERMINAL_OUTCOMES = new Set(['completed', 'blocked', 'needs_input', 'cancelled', 'denied', 'incomplete', 'failed']);

export class FinalizationFaults {
  constructor(primary, outcome, causeId) {
    if (!TERMINAL_OUTCOMES.has(outcome) || typeof causeId !== 'string' || !causeId) {
      throw new TypeError('finalization faults require a terminal outcome and cause id');
    }
    this.primary = primary;
    this.outcome = outcome;
    this.causeId = causeId;
    this.secondary = [];
    this.committed = false;
  }

  latchCommit() { this.committed = true; }

  async capture(boundary, operation) {
    try {
      return await operation();
    } catch (error) {
      this.#record(error, boundary);
      return undefined;
    }
  }

  #record(error, boundary) {
    const detail = failureEnvelope(error, {
      boundary, operation: 'turn_finalization', causeId: this.causeId,
    });
    if (this.primary !== null && this.primary !== undefined || this.committed) {
      this.secondary.push(detail);
      return;
    }
    this.primary = detail;
    this.outcome = 'failed';
  }
}
