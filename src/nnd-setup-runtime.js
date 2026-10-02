// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function createNndSetupRuntime({ loadConfiguration, createHost, activationTimeoutMs = 20_000, closeTimeoutMs = 15_000 }) {
  if (typeof loadConfiguration !== 'function' || typeof createHost !== 'function') {
    throw new TypeError('NND setup runtime requires configuration and host factories.');
  }
  return new NndSetupRuntime(loadConfiguration, createHost, timeout(activationTimeoutMs), timeout(closeTimeoutMs));
}

class NndSetupRuntime {
  #load;
  #create;
  #host = null;
  #pending = null;
  #closing = false;
  #closed;
  #state = 'setup_required';
  #configuration = 'unverified';
  #failure = null;
  #error = null;
  #cleanupFailure = null;
  #activationTimeout;
  #closeTimeout;
  #controller;
  #expired = false;

  constructor(load, create, activationTimeout, closeTimeout) {
    this.#load = load; this.#create = create;
    this.#activationTimeout = activationTimeout; this.#closeTimeout = closeTimeout;
  }

  start() {
    // Invariant: the runtime owns both the bounded caller result and the underlying operation.
    this.activate().catch((error) => { this.#error = error; });
  }

  snapshot() {
    return Object.freeze({
      service_state: this.#state, configuration_state: this.#configuration,
      execution_state: this.#host && !this.#closing ? 'ready' : 'unavailable',
      provider_state: 'unknown', failure_code: this.#failure,
    });
  }

  getHost() { return this.#closing ? null : this.#host; }
  getFailure() { return this.#error; }

  activate() {
    if (this.#closing) return Promise.reject(new ContractError('nnd_setup_stopped', 'NND runtime is stopping or stopped.'));
    if (this.#cleanupFailure) return Promise.reject(new ContractError('nnd_setup_cleanup_failed', 'NND cleanup failed. Restart the native process before retrying.'));
    if (this.#expired) return Promise.reject(new ContractError('nnd_setup_activation_timeout', 'NND activation timed out. Restart the native process before retrying.'));
    if (this.#pending) return Promise.reject(new ContractError('nnd_setup_busy', 'NND activation is already running.'));
    if (this.#host) return Promise.resolve(this.snapshot());
    this.#state = 'starting';
    this.#failure = null;
    this.#error = null;
    this.#controller = new AbortController();
    this.#pending = this.#activate().finally(() => { this.#pending = null; });
    return bounded(this.#pending, this.#activationTimeout, () => {
      this.#expired = true; this.#controller.abort();
      this.#state = 'failed'; this.#failure = 'nnd_setup_activation_timeout';
      this.#error = new ContractError(this.#failure, 'NND activation exceeded its time bound.');
      return this.#error;
    });
  }

  async #activate() {
    let config;
    try { config = await this.#load(this.#controller.signal); }
    catch (error) {
      this.#error = error;
      this.#configuration = 'invalid';
      return this.#failed('setup_required', 'nnd_setup_configuration_invalid');
    }
    this.#configuration = 'ready';
    if (this.#closing || this.#expired) return this.snapshot();
    let candidate;
    try {
      candidate = await this.#create(config, { signal: this.#controller.signal });
      if (!candidate || typeof candidate.shutdown !== 'function') throw new Error('Invalid host factory result.');
      if (this.#closing || this.#expired) {
        try { await candidate.shutdown(); }
        catch (error) { this.#cleanupFailure = error; throw error; }
        return this.snapshot();
      }
      this.#host = candidate;
      this.#state = 'ready';
      return this.snapshot();
    } catch (error) {
      this.#error = error;
      if (error?.code === 'nnd_setup_cleanup_failed') this.#cleanupFailure = error;
      return this.#failed('failed', this.#cleanupFailure ? 'nnd_setup_cleanup_failed' : 'nnd_setup_host_failed');
    }
  }

  #failed(state, code) {
    if (!this.#expired) this.#failure = code;
    if (!this.#closing && !this.#expired) this.#state = state;
    return this.snapshot();
  }

  close() {
    if (this.#closed) return this.#closed;
    this.#closing = true;
    this.#state = 'stopping';
    this.#controller?.abort();
    this.#closed = bounded(this.#close(), this.#closeTimeout, () => {
      this.#state = 'failed'; this.#failure = 'nnd_setup_shutdown_timeout';
      this.#error = new ContractError(this.#failure, 'NND shutdown exceeded its time bound; cleanup remains owned.');
      return this.#error;
    });
    return this.#closed;
  }

  async #close() {
    await this.#pending;
    const host = this.#host;
    this.#host = null;
    try {
      if (this.#cleanupFailure) throw this.#cleanupFailure;
      await host?.shutdown(); this.#state = 'stopped';
    }
    catch (cause) {
      this.#state = 'failed'; this.#failure = 'nnd_setup_host_failed';
      throw new ContractError('nnd_setup_host_failed', 'NND runtime shutdown failed.', { cause });
    }
  }
}

function timeout(value) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) {
    throw new ContractError('nnd_setup_timeout_invalid', 'NND lifecycle timeout must be between 100 and 300000 milliseconds.');
  }
  return value;
}

function bounded(operation, milliseconds, expired) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(expired()), milliseconds);
    // Invariant: observing a timeout never drops the operation or its rejection handler.
    operation.then((value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); });
  });
}
