// SPDX-License-Identifier: Apache-2.0
import { failureEnvelope } from './failure-envelope.js';

export class FinalizationFaults {
  constructor(primary, outcome, causeId) {
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
    if (this.primary || this.committed) {
      this.secondary.push(detail);
      return;
    }
    this.primary = detail;
    this.outcome = 'failed';
  }
}
