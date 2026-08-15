// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { validateCommand } from './contracts.js';

export class CanonicalIngress {
  #seen = new Map();

  constructor(engine, options = {}) {
    this.engine = engine;
    this.maxIdentities = options.maxIdentities ?? 4096;
    if (!Number.isSafeInteger(this.maxIdentities) || this.maxIdentities < 1) {
      throw new ContractError('ingress_capacity_invalid', 'idempotency capacity must be a positive integer');
    }
    this.interactive = options.interactive === true;
  }

  async submit(rawCommand, principal = 'stdio-host') {
    const command = validateCommand(rawCommand, { interactive: this.interactive });
    const prior = this.#seen.get(command.request_id);
    if (prior) return { accepted: false, duplicate: true, pending: !prior.settled };
    if (this.#seen.size >= this.maxIdentities) {
      throw new ContractError('ingress_capacity', 'idempotency window is full');
    }
    const operation = this.#route(command, principal);
    const entry = { operation, type: command.type, settled: false };
    this.#seen.set(command.request_id, entry);
    operation.then(() => { entry.settled = true; }, () => { entry.settled = true; });
    return operation;
  }

  async #route(command, principal) {
    if (command.type === 'submit') return this.engine.submit(command, principal);
    if (command.type === 'steer') {
      if (this.engine.config.executionManifest?.allowedCapabilities.includes('steering') === false) {
        throw new ContractError('capability_not_allowed', 'the host execution manifest does not allow steering');
      }
      return this.engine.steer(command, principal);
    }
    if (command.type === 'cancel') return this.engine.cancel(command, principal);
    if (command.type === 'attachment_retry') return this.engine.retryAttachment(command, principal);
    if (command.type === 'attachment_remove') return this.engine.removeAttachment(command, principal);
    if (command.type === 'permission_decision') return this.engine.decidePermission(command, principal);
    if (command.type === 'configuration_update') return this.engine.updateConfiguration(command, principal);
    if (command.type === 'shutdown') return this.engine.shutdown(command, principal);
    throw new ContractError('unsupported_control', `${command.type} is not accepted by canonical ingress`);
  }
}
