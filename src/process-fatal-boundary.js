// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class ProcessFatalBoundary {
  #cleanup = new Set();
  #tripped = false;
  #completion = null;

  constructor(options = {}) {
    this.process = options.process ?? process;
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.writeMarker = options.writeMarker ?? ((marker) => appendFatalMarker(options.logPath, marker));
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.version = options.version ?? 'unknown';
    this.onUnhandledRejection = (reason) => { void this.#trip('unhandled_rejection', reason); };
    this.onUncaughtException = (error) => { void this.#trip('uncaught_exception', error); };
  }

  install() {
    this.process.on('unhandledRejection', this.onUnhandledRejection);
    this.process.on('uncaughtException', this.onUncaughtException);
    return this;
  }

  registerCleanup(operation) {
    if (typeof operation !== 'function') return () => undefined;
    this.#cleanup.add(operation);
    return () => this.#cleanup.delete(operation);
  }

  dispose() {
    this.process.removeListener('unhandledRejection', this.onUnhandledRejection);
    this.process.removeListener('uncaughtException', this.onUncaughtException);
    this.#cleanup.clear();
  }

  get completion() { return this.#completion; }

  #trip(kind, error) {
    if (this.#tripped) return this.#completion;
    this.#tripped = true;
    this.process.exitCode = 1;
    try { this.writeMarker(fatalMarker(kind, error, this.version)); } catch { /* fatal logging is best-effort */ }
    const cleanup = [...this.#cleanup].map((operation) => {
      try { return Promise.resolve(operation()); } catch (cleanupError) { return Promise.reject(cleanupError); }
    });
    this.#completion = settleBeforeDeadline(cleanup, this.timeoutMs)
      .finally(() => this.exit(1));
    this.#completion.catch(() => undefined);
    return this.#completion;
  }
}

export function installProcessFatalBoundary(options = {}) {
  return new ProcessFatalBoundary(options).install();
}

export function fatalMarker(kind, error, version) {
  const code = safeLabel(error?.code, 'internal_failure');
  const name = safeLabel(error?.name, 'Error');
  const fingerprint = createHash('sha256').update(`${kind}\0${name}\0${code}`).digest('hex');
  return Object.freeze({
    timestamp: new Date().toISOString(), severity: 'fatal', category: 'process',
    code: 'process_fatal', kind, error_name: name, error_code: code,
    fingerprint, product_version: version, pid: process.pid,
  });
}

function appendFatalMarker(path, marker) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function settleBeforeDeadline(operations, timeoutMs) {
  if (operations.length === 0) return Promise.resolve();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  return Promise.race([Promise.allSettled(operations), deadline]).finally(() => clearTimeout(timer));
}

function safeLabel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:@/-]+/gu, '_').slice(0, 96);
  return /^[A-Za-z0-9]/u.test(normalized) ? normalized : fallback;
}
